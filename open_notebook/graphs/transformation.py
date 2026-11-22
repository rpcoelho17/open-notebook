from ai_prompter import Prompter
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

from open_notebook.ai.provision import provision_langchain_model
from open_notebook.domain.notebook import Source
from open_notebook.domain.transformation import DefaultPrompts, Transformation
from open_notebook.exceptions import (
    IncompleteGenerationError,
    InvalidInputError,
    OpenNotebookError,
)
from open_notebook.utils import clean_thinking_content
from open_notebook.utils.error_classifier import classify_error
from open_notebook.utils.source_context import (
    looks_like_provider_error_dump,
    prepare_source_for_summary,
)
from open_notebook.utils.text_utils import extract_text_content


class TransformationState(TypedDict):
    input_text: str
    source: Source
    transformation: Transformation
    output: str


async def run_transformation(state: dict, config: RunnableConfig) -> dict:
    source_obj = state.get("source")
    source: Source = source_obj if isinstance(source_obj, Source) else None  # type: ignore[assignment]
    content = state.get("input_text")
    assert source or content, "No content to transform"
    transformation: Transformation = state["transformation"]

    try:
        if not content:
            content = source.full_text
        if not content or not str(content).strip():
            # A source whose extraction produced no text would hand the model
            # an empty input, and whatever it invents would be saved as an
            # insight.
            raise InvalidInputError("There is no text content to transform")
        # transformation.prompt is user-controlled free text. Never compile it as
        # Jinja template *source* (Prompter(template_text=...)) - pass it as a
        # plain render variable into a fixed, developer-authored template instead.
        # See docs/7-DEVELOPMENT/security.md (GHSA-f35w-wx37-26q7).
        instructions = transformation.prompt
        default_prompts: DefaultPrompts = await DefaultPrompts.get_instance(
            force_reload=True
        )  # type: ignore[assignment]
        if default_prompts.transformation_instructions:
            instructions = (
                f"{default_prompts.transformation_instructions}\n\n{instructions}"
            )

        system_prompt = Prompter(prompt_template="transformation/execute").render(
            data={**state, "instructions": instructions}
        )
        content_str = str(content) if content else ""
        # Condense massive sources (e.g. 800k+ char GitHub repos or textbooks) smartly
        # so every model provider (Codex, Claude Code, Anthropic, Gemini, Ollama) gets
        # the full Overview/TOC + prioritized sections without overflowing context.
        if len(content_str) > 320_000:
            src_title = (source.title if source and source.title else "Source")
            content_str = prepare_source_for_summary(
                src_title, content_str, max_chars=320_000
            )
        payload = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=content_str),
        ]
        chain = await provision_langchain_model(
            str(payload),
            config.get("configurable", {}).get("model_id"),
            "transformation",
            max_tokens=8192,
        )

        response = await chain.ainvoke(payload)

        # Provider adapters use different keys for the termination reason.
        # Check before saving: a nonempty answer can still be incomplete.
        metadata = response.response_metadata
        for key in ("finish_reason", "stop_reason", "done_reason"):
            reason = metadata.get(key)
            if isinstance(reason, str) and reason.lower() in ("length", "max_tokens"):
                raise IncompleteGenerationError(
                    "The model reached its generation limit before completing the "
                    "transformation. Try a shorter transformation or a different model."
                )

        # Clean thinking content from the response
        response_content = extract_text_content(response.content)
        cleaned_content = clean_thinking_content(response_content)

        if not cleaned_content.strip():
            raise IncompleteGenerationError(
                "The model returned no usable text for the transformation after "
                "removing thinking content. Try a shorter transformation or a "
                "different model."
            )

        error_dump_reason = looks_like_provider_error_dump(cleaned_content)
        if error_dump_reason:
            raise IncompleteGenerationError(
                f"The model failed during transformation ({error_dump_reason}). "
                "Check your model provider/bridge configuration and retry."
            )

        if source:
            await source.add_insight(transformation.title, cleaned_content)

        return {
            "output": cleaned_content,
        }
    except OpenNotebookError:
        raise
    except Exception as e:
        error_class, user_message = classify_error(e)
        raise error_class(user_message) from e


agent_state = StateGraph(TransformationState)
agent_state.add_node("agent", run_transformation)  # type: ignore[type-var]
agent_state.add_edge(START, "agent")
agent_state.add_edge("agent", END)
graph = agent_state.compile()
