from typing import List, Optional

from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage
from loguru import logger
from pydantic import BaseModel, Field

from api.models import (
    DefaultPromptResponse,
    DefaultPromptUpdate,
    TransformationCreate,
    TransformationExecuteRequest,
    TransformationExecuteResponse,
    TransformationResponse,
    TransformationUpdate,
)
from open_notebook.ai.models import Model
from open_notebook.ai.provision import provision_langchain_model
from open_notebook.domain.transformation import DefaultPrompts, Transformation
from open_notebook.exceptions import InvalidInputError, OpenNotebookError
from open_notebook.graphs.transformation import graph as transformation_graph
from open_notebook.utils import clean_thinking_content
from open_notebook.utils.source_context import (
    build_notebook_studio_context,
    looks_like_provider_error_dump,
)
from open_notebook.utils.text_utils import extract_text_content

router = APIRouter()


class StudioGenerateRequest(BaseModel):
    notebook_id: str = Field(..., description="Notebook ID to read sources from")
    source_ids: Optional[List[str]] = Field(
        None, description="Optional subset of source IDs; defaults to all notebook sources"
    )
    prompt: str = Field(..., description="Task instructions for the Studio output")
    system_prompt: Optional[str] = Field(
        None, description="Optional system prompt override"
    )
    model_id: Optional[str] = Field(
        None, description="Optional explicit Open Notebook model ID"
    )
    max_source_chars: int = Field(
        220_000,
        ge=8_000,
        le=400_000,
        description="Maximum character budget for assembled source content",
    )
    focus_query: Optional[str] = Field(
        None,
        description="Optional custom focus prompt used to boost relevant vector passages for large sources",
    )


class StudioGenerateResponse(BaseModel):
    output: str
    source_count: int
    model_name: str


def _transformation_response(transformation: Transformation) -> TransformationResponse:
    return TransformationResponse(
        id=transformation.id or "",
        name=transformation.name,
        title=transformation.title,
        description=transformation.description,
        prompt=transformation.prompt,
        apply_default=transformation.apply_default,
        model_id=transformation.model_id,
        created=str(transformation.created),
        updated=str(transformation.updated),
    )


@router.get("/transformations", response_model=List[TransformationResponse])
async def get_transformations():
    """Get all transformations."""
    try:
        transformations = await Transformation.get_all(order_by="name asc")

        return [
            _transformation_response(transformation)
            for transformation in transformations
        ]
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching transformations: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error fetching transformations: {str(e)}"
        )


@router.post("/transformations", response_model=TransformationResponse)
async def create_transformation(transformation_data: TransformationCreate):
    """Create a new transformation."""
    try:
        # Reject unknown model references up front (same check as execute);
        # otherwise an invalid model_id is stored and only fails at run time.
        if transformation_data.model_id:
            model = await Model.get(transformation_data.model_id)
            if not model:
                raise HTTPException(status_code=404, detail="Model not found")

        new_transformation = Transformation(
            name=transformation_data.name,
            title=transformation_data.title,
            description=transformation_data.description,
            prompt=transformation_data.prompt,
            apply_default=transformation_data.apply_default,
            model_id=transformation_data.model_id,
        )
        await new_transformation.save()

        return _transformation_response(new_transformation)
    except HTTPException:
        raise
    except InvalidInputError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error creating transformation: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error creating transformation: {str(e)}"
        )


@router.post("/transformations/studio-generate", response_model=StudioGenerateResponse)
async def studio_generate(request: StudioGenerateRequest):
    """Generate a Studio report, Dense Summary, or Infographic using any configured Open Notebook model.

    Model-agnostic: works identically with Codex, Claude Code, Anthropic, OpenAI,
    Gemini, and Ollama models via Open Notebook's unified model provisioner, and
    reads real source full_text directly (never stale or corrupted insights).
    """
    try:
        source_context, source_count = await build_notebook_studio_context(
            notebook_id=request.notebook_id,
            source_ids=request.source_ids,
            max_total_chars=request.max_source_chars,
            focus_query=request.focus_query,
        )
        if not source_context.strip():
            raise HTTPException(
                status_code=400,
                detail="Selected sources have no extracted text content yet.",
            )

        sys_text = (
            request.system_prompt
            or "You are an expert research analyst. Write clear, thorough, well-structured Markdown grounded strictly in the provided sources. Start with a concise # Title line."
        )
        user_text = f"{request.prompt}\n\nSOURCES:\n{source_context}"
        payload = [
            SystemMessage(content=sys_text),
            HumanMessage(content=user_text),
        ]

        chain = await provision_langchain_model(
            user_text,
            request.model_id,
            "transformation",
            max_tokens=8192,
        )
        response = await chain.ainvoke(payload)
        raw_output = extract_text_content(response.content)
        cleaned = clean_thinking_content(raw_output).strip()

        error_dump = looks_like_provider_error_dump(cleaned)
        if error_dump:
            raise HTTPException(
                status_code=502,
                detail=f"Model generation failed ({error_dump}).",
            )
        if not cleaned:
            raise HTTPException(
                status_code=502,
                detail="Model returned empty output.",
            )

        model_name = str(
            getattr(chain, "model_name", None)
            or getattr(chain, "model", None)
            or "configured-model"
        )
        return StudioGenerateResponse(
            output=cleaned,
            source_count=source_count,
            model_name=model_name,
        )
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Studio generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Studio generation failed: {str(e)}")


@router.post("/transformations/execute", response_model=TransformationExecuteResponse)
async def execute_transformation(execute_request: TransformationExecuteRequest):
    """Execute a transformation on input text."""
    try:
        # Validate transformation exists
        transformation = await Transformation.get(execute_request.transformation_id)
        if not transformation:
            raise HTTPException(status_code=404, detail="Transformation not found")

        model_id = execute_request.model_id or transformation.model_id

        # Validate explicit or transformation-specific model exists.
        # None is allowed so the graph can use the configured transformation default.
        if model_id:
            model = await Model.get(model_id)
            if not model:
                raise HTTPException(status_code=404, detail="Model not found")

        # Execute the transformation.
        # LangGraph accepts a partial state dict at runtime, but its typed
        # overloads require the full state type (langgraph typing limitation).
        result = await transformation_graph.ainvoke(  # type: ignore[call-overload]
            dict(
                input_text=execute_request.input_text,
                transformation=transformation,
            ),
            config=dict(configurable={"model_id": model_id}),
        )

        return TransformationExecuteResponse(
            output=result["output"],
            transformation_id=execute_request.transformation_id,
            model_id=model_id,
        )

    except HTTPException:
        raise
    except OpenNotebookError:
        raise  # Let global exception handlers return proper status codes
    except Exception as e:
        logger.error(f"Error executing transformation: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error executing transformation: {str(e)}"
        )


@router.get("/transformations/default-prompt", response_model=DefaultPromptResponse)
async def get_default_prompt():
    """Get the default transformation prompt."""
    try:
        default_prompts: DefaultPrompts = await DefaultPrompts.get_instance()  # type: ignore[assignment]

        return DefaultPromptResponse(
            transformation_instructions=default_prompts.transformation_instructions
            or ""
        )
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching default prompt: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error fetching default prompt: {str(e)}"
        )


@router.put("/transformations/default-prompt", response_model=DefaultPromptResponse)
async def update_default_prompt(prompt_update: DefaultPromptUpdate):
    """Update the default transformation prompt."""
    try:
        default_prompts: DefaultPrompts = await DefaultPrompts.get_instance()  # type: ignore[assignment]

        default_prompts.transformation_instructions = (
            prompt_update.transformation_instructions
        )
        await default_prompts.update()

        return DefaultPromptResponse(
            transformation_instructions=default_prompts.transformation_instructions
        )
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error updating default prompt: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error updating default prompt: {str(e)}"
        )


@router.get(
    "/transformations/{transformation_id}", response_model=TransformationResponse
)
async def get_transformation(transformation_id: str):
    """Get a specific transformation by ID."""
    try:
        transformation = await Transformation.get(transformation_id)
        if not transformation:
            raise HTTPException(status_code=404, detail="Transformation not found")

        return _transformation_response(transformation)
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching transformation {transformation_id}: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error fetching transformation: {str(e)}"
        )


@router.put(
    "/transformations/{transformation_id}", response_model=TransformationResponse
)
async def update_transformation(
    transformation_id: str, transformation_update: TransformationUpdate
):
    """Update a transformation."""
    try:
        transformation = await Transformation.get(transformation_id)
        if not transformation:
            raise HTTPException(status_code=404, detail="Transformation not found")

        # Update only provided fields
        if transformation_update.name is not None:
            transformation.name = transformation_update.name
        if transformation_update.title is not None:
            transformation.title = transformation_update.title
        # An explicit "" (or null) clears the description; only an absent
        # field leaves it untouched.
        if "description" in transformation_update.model_fields_set:
            transformation.description = transformation_update.description or ""
        if transformation_update.prompt is not None:
            transformation.prompt = transformation_update.prompt
        if transformation_update.apply_default is not None:
            transformation.apply_default = transformation_update.apply_default
        if "model_id" in transformation_update.model_fields_set:
            # Validate a newly supplied model reference (allow clearing to None).
            if transformation_update.model_id:
                model = await Model.get(transformation_update.model_id)
                if not model:
                    raise HTTPException(status_code=404, detail="Model not found")
            transformation.model_id = transformation_update.model_id

        await transformation.save()

        return _transformation_response(transformation)
    except HTTPException:
        raise
    except InvalidInputError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error updating transformation {transformation_id}: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error updating transformation: {str(e)}"
        )


@router.delete("/transformations/{transformation_id}")
async def delete_transformation(transformation_id: str):
    """Delete a transformation."""
    try:
        transformation = await Transformation.get(transformation_id)
        if not transformation:
            raise HTTPException(status_code=404, detail="Transformation not found")

        await transformation.delete()

        return {"message": "Transformation deleted successfully"}
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error deleting transformation {transformation_id}: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error deleting transformation: {str(e)}"
        )
