# Interface Overview - Finding Your Way Around

## The Sidebar

All management and library pages (`/notebooks`, `/sources`, `/search`, `/podcasts`, `/transformations`, `/settings`, `/settings/models`, and `/advanced`) show a collapsible navigation sidebar on the left.

Individual **notebook pages** (`/notebooks/<id>`) and **source pages** hide this sidebar to give the 3-column workspace full screen width. From inside any notebook, you can get back to the sidebar in three ways:

1. Click the **Open Notebook logo** in the top-left of the notebook header (or the **avatar pill** in the top-right) to return to **All Notebooks** (`/notebooks`), where the sidebar is shown.
2. Click the **Navigation grid icon (`⊞`)** in the top-right of the notebook header to jump straight to **All Notebooks**, **Podcasts**, **Transformations**, **Models & Providers**, or **App Settings** (all of which show the sidebar).
3. Press **`Ctrl+K`** (**`⌘K`** on Mac) anywhere to open **Quick actions** and jump directly to any sidebar page, including **Sources**, **Ask and Search**, and **Advanced**.

```
┌──────────────────────┐
│ Open Notebook        │
│ [+ New]              │  → Source, Notebook, Podcast
│                      │
│ COLLECT              │
│   Sources            │
│ PROCESS              │
│   Notebooks          │
│   Ask and Search     │
│ CREATE               │
│   Podcasts           │
│ MANAGE               │
│   Models             │
│   Transformations    │
│   Settings           │
│   Advanced           │
│                      │
│ Quick actions   ⌘K   │
│ Theme · Language ·   │
│ Sign Out             │
└──────────────────────┘
```

| Item | What it's for |
|------|---------------|
| **New** | Create a source, notebook or podcast episode from anywhere |
| **Sources** | Your source library: every source, whichever notebooks it is in |
| **Notebooks** | Your notebooks: recently viewed, active and archived, in tile or list view |
| **Ask and Search** | Ask questions across your knowledge base, or search it ([Search and Ask](search.md)) |
| **Podcasts** | Generated episodes and the episode/speaker profiles ([Creating Podcasts](creating-podcasts.md)) |
| **Models** | AI provider configurations and default models ([API Configuration](api-configuration.md)) |
| **Transformations** | Your transformation prompts and the Playground ([Transformations](transformations.md)) |
| **Settings** | Content Processing, Embedding and Search, File Management |
| **Advanced** | System Info (version and update check) and Rebuild Embeddings |
| **Quick actions** | The command palette: jump to pages and notebooks, search or ask, create items, change theme |
| **Theme / Language** | Light, dark or system theme; interface language |

---

## The Notebook Page

Opening a notebook displays a full-width dark workspace with a streamlined top header and three columns ordered **`Sources` | `Chat` | `Studio`**.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ [Logo] Notebook name (click to edit)     [+ Create notebook] [⋮] [⚙] [⊞] R│
├───────────────────┬──────────────────────────────────┬─────────────────────┤
│ SOURCES      [◧]  │ CHAT                   [Sessions]│ STUDIO          [◨] │
│ [+ Add sources]   │                                  │ ┌────────┬────────┐ │
│ Link existing  ☑  │  Auto-generated Notebook         │ │ Audio  │Reports │ │
│                   │  Overview (all active sources)   │ │Overview│        │ │
│ ┌───────────────┐ │  [Save to note] [Copy] [🔊] [↻]  │ ├────────┼────────┤ │
│ │ 📂 owner/repo │ │  ──────────────────────────────  │ │Infogr. │Add note│ │
│ │ 📄 book.pdf   │ │  Chat & voice turns with live    │ └────────┴────────┘ │
│ │ 🌐 article    │ │  word-by-word speech highlight   │                     │
│ └───────────────┘ │                                  │ 🎧 Audio Overview   │
│  (drag edge to    │  [Ask anything...]               │    [-5s][▶][+5s]    │
│   resize width)   │  [Sliders][🌐 Web]  [🎙] [↑]     │ 📄 Briefing Doc     │
│                   │                                  │ 📊 Infographic      │
└───────────────────┴──────────────────────────────────┴─────────────────────┘
```

- **Header controls:** Click the notebook title to rename inline; use **+ Create notebook** to start a new notebook; **⋮** to archive or delete; **⚙** to open **Voice, Chat Model & Studio Settings** (Speech-to-Speech engine, Gemini Live input mode, voices, Default Chat Model, and dynamic Context Window slider); and **⊞** to jump to other Open Notebook pages.
- **Responsive layout:** On desktop, both **Sources** and **Studio** can be collapsed to slim icon strips, and the **Sources** column edge can be dragged to resize (`220px–560px`). On small screens, the columns become three tabs: **Sources**, **Chat**, and **Studio** (with **Chat** selected first).

### Sources column (left)

- **+ Add sources** opens the source wizard with four tabs: **Link** (single or batch URLs, with a one-click banner if a GitHub repository URL is pasted), **GitHub** (dedicated repository/directory importer with live **Preview**, subfolder & extension filters, and optional private-repo token), **Upload** (files up to 200 MB), and **Text** (pasted text). See [Adding Sources](adding-sources.md).
- **Link existing** connects sources already in your library without re-uploading.
- **Checkboxes** toggle which sources are included in chat, voice, and Studio context (with a bulk **Select all** toggle).
- Hovering over a source card shows its full wrapped title and URL; clicking a card opens the **Source View**; the **⋮ menu** offers **Remove from notebook**, **Retry**, and **Delete**.

### Chat column (center)

- **Notebook Overview:** Automatically synthesizes all completed sources in the notebook into a concise overview paragraph at the top of Chat (re-generated whenever sources are added or removed), with **Save to note**, **Copy**, **Read Aloud**, and **Regenerate** buttons.
- **Sessions:** Switch between or create saved chat sessions for the notebook.
- **Hybrid Vector RAG:** Automatically combines source overviews/Tables of Contents with scoped vector-matched passages so large textbooks and multi-file GitHub repositories stay accurate within model context limits.
- **Voice Chat (Speech-to-Speech):** Click the voice icon inside the chat input bar to talk directly to your documents using either **Gemini Live** *(with real-time word-by-word text highlighting synced to speech, plus Press ↑ to send or Hands-free mode)* or **Local Voice + Chat Model** (`faster-whisper` + Kokoro-82M TTS).
- **Chat Input Controls:** Use the **Sliders** popover to switch Speech-to-Speech engines, input modes, and Thinking Effort on the fly; toggle **Web Search** directly from the chat input to answer strictly from notebook sources or expand to the web.
- **Message Actions:** Every AI reply includes **Save to note**, **Copy**, **Read Aloud**, and **Delete** (in-place deletion without losing scroll position); user messages also include an inline **Delete** button.

### Studio column (right)

Replaces the classic Notes column with a unified output workspace:

- **Audio Overview:** Opens the podcast generator pre-expanded to the current notebook. Adding custom focus instructions automatically prioritizes matching passages via Hybrid Vector RAG. Active and completed episodes appear at the top of Studio with a built-in **Custom Audio Player** featuring **5-second rewind/forward skip buttons**, scrubbable progress bar, speed toggle (`1x–2x`), mute, and MP3 download.
- **Reports:** Opens **Create Report** with built-in **Executive Briefing Doc**, **Briefing Doc**, **Study Guide & Q&A**, and all **Open Notebook Transformations**. Click any card to generate immediately, or click its **`Prompt`** button (pencil + 3 dots) to customize the prompt for that single run without overwriting the default.
- **Infographic:** Generates a self-contained dark-themed HTML/SVG visual infographic from your selected sources and saves it as a Studio card.
- **Add note / Saved Notes:** Click any saved note or report card to open it in **rendered Markdown preview** by default (with Edit, Split, and Preview toggles on the toolbar).

---

## The Source View

Clicking a source opens it with three tabs:

- **Content:** The extracted text (and embedded video for YouTube links). Imported **GitHub repositories** render a structured top reference (**Overview**, **Table of Contents** directory tree, **Main Files & What They Do**, **Architecture & Entry Points**, and **Tech Stack**) followed by a collapsible, searchable **Indexed Source Files** code browser.
- **Insights:** Transformation outputs generated for the source, plus **Generate New Insight**. Opening an insight includes **Save as Note** pre-selected to your current notebook. See [Transformations](transformations.md).
- **Details:** Topics, embedding status, timestamps, and notebook associations (**Manage Notebooks**).

**Chat with Sources** opens the source's dedicated page (source on the left, focused chat on the right). The **⋮ menu** provides **Download File** (for stored uploads), **Embed Content**, and **Delete Source**.

---

## Other Pages

- **Sources** (`/sources`): A library table of all sources across notebooks with type, insight count, and embedding status.
- **Notebooks** (`/notebooks`): **New Notebook**, search, deduplicated **Recently Viewed** notebooks, and **Active / Archived Notebooks**.
- **Settings** (`/settings`): Content Processing (document and URL engines, OCR and Docling options; see [Content Processing Engines](content-processing-engines.md)), Embedding and Search (**Default Embedding Option**), and File Management (**Auto Delete Files**).
- **Advanced** (`/advanced`): **System Info** (version and update check) and **Rebuild Embeddings** (background re-embedding for *Existing* or *All* sources).

---

## Keyboard Shortcuts

| Shortcut | Where | Action |
|----------|-------|--------|
| **Ctrl+K** / **⌘K** | Anywhere | Open Quick actions (command palette) |
| **Enter** | Chat input bar | Send message |
| **Shift+Enter** | Chat input bar | New line |
| **Ctrl+Enter** / **⌘+Enter** | Ask question box | Ask |
| **Enter** | Search box | Search |
