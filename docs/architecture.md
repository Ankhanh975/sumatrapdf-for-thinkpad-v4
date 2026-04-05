# SumatraPDF — Application Engine Architecture

> This document describes the core application engine ("backend") of this fork of SumatraPDF, customised for ThinkPad touchpad use. It covers the startup flow, key components, rendering pipeline, and build instructions.

---

## Table of Contents

1. [Overview](#overview)
2. [Repository Layout](#repository-layout)
3. [Entry Point & Startup Flow](#entry-point--startup-flow)
4. [Component Map](#component-map)
   - [Document Engine Layer](#document-engine-layer)
   - [Rendering Pipeline](#rendering-pipeline)
   - [UI Layer](#ui-layer)
   - [Settings & Configuration](#settings--configuration)
   - [Utility Layer](#utility-layer)
   - [Accessibility](#accessibility)
   - [Background / Async Services](#background--async-services)
5. [Key Execution Flows](#key-execution-flows)
   - [Opening a Document](#opening-a-document)
   - [Page Rendering](#page-rendering)
   - [Text Search](#text-search)
   - [Printing](#printing)
6. [ThinkPad-Specific Customisations](#thinkpad-specific-customisations)
7. [External Dependencies](#external-dependencies)
8. [Build Instructions](#build-instructions)
9. [Running & Debugging Locally](#running--debugging-locally)

---

## Overview

SumatraPDF is a **Windows-native, multi-format document viewer** written in C++ (~65,000 lines across `src/`). There is no separate server process; the "backend" is the in-process application engine that handles:

- Format-specific document parsing and text extraction (the *engine layer*)
- Page layout calculation and rendering (the *display/render layer*)
- A Windows message-loop UI built on top of Win32 (the *UI layer*)
- Persistent settings, file history, and per-document state (the *settings layer*)

The project uses **Premake5** (Lua) to generate a Visual Studio 2022 solution and **Bun** (TypeScript) scripts in `cmd/` to drive MSBuild.

---

## Repository Layout

```
sumatrapdf-for-thinkpad-v4/
├── src/                    # All C++ application source
│   ├── utils/              # Platform-agnostic helpers (strings, files, parsing…)
│   ├── wingui/             # Thin Win32 widget wrappers (Wnd, Button, Edit…)
│   ├── mui/                # Markup-UI layout library
│   ├── uia/                # UI-Automation (accessibility) providers
│   ├── ifilter/            # Windows IFilter shell integration (legacy)
│   ├── ifilter2/           # Windows IFilter shell integration (current)
│   ├── previewer/          # Shell thumbnail/preview DLL (v1)
│   ├── previewer2/         # Shell thumbnail/preview DLL (v2)
│   ├── testcode/           # Small test applications
│   └── regress/            # Regression test suite
├── ext/                    # Third-party libraries (MuPDF, freetype, zlib…)
├── mupdf/                  # MuPDF PDF-rendering library (vendored)
├── cmd/                    # TypeScript build / tooling scripts (Bun)
├── docs/                   # Documentation (this file lives here)
├── vs2022/                 # Visual Studio 2022 solution & project files
├── premake5.lua            # Premake5 build configuration
├── premake5.files.lua      # Premake5 file-list configuration
└── readme.md               # Fork overview & known issues
```

---

## Entry Point & Startup Flow

**Entry point:** `src/SumatraStartup.cpp` — `WinMain()` (line ~2100)

```
WinMain()
 │
 ├─ Security / runtime init
 │   RememberMainUIThreadId(), InitDynCalls(), NoDllHijacking(),
 │   DisableDataExecution(), SetupCrashHandler()
 │
 ├─ COM / GDI+ / MUI / UITask init
 │   ScopedOle, InitAllCommonControls, ScopedGdiPlus,
 │   mui::Initialize(), uitask::Initialize()
 │
 ├─ Command-line parsing
 │   ParseFlags(GetCommandLineW(), flags)
 │
 ├─ Early-exit modes (each calls ExitProcess when done)
 │   • -preview-pipe  → RunPreviewPipeServer()
 │   • -ifilter-pipe  → RunIFilterPipeServer()
 │   • -install / -uninstall → RunInstaller() / RunUninstaller()
 │   • -engine-dump   → EngineDump()
 │   • -bench         → BenchFileOrDir()
 │   • -print         → PrintFile()
 │
 ├─ Settings & theme init
 │   DarkMode::initDarkMode(), LoadSettings(),
 │   UpdateGlobalPrefs(flags), SetCurrentLang()
 │
 ├─ Window class & instance registration
 │   RegisterWinClass(), InstanceInit()
 │
 ├─ Single-instance / DDE hand-off
 │   FindPrevInstWindow() → if found, forward via DDE and exit
 │
 ├─ libmupdf.dll load
 │   LoadLibmupdf()  ← required for PDF rendering
 │
 ├─ Session restore / file open
 │   CreateAndShowMainWindow()
 │   RestoreTabOnStartup() or LoadOnStartup() per file
 │
 ├─ Post-startup tasks
 │   StartAsyncUpdateCheck(), StartDeleteStaleFiles(),
 │   RegisterSettingsForFileChanges()
 │
 └─ Message loop
     RunMessageLoop()   ← blocks until all windows closed
```

`SumatraPDF.cpp` (6,578 lines) acts as the central coordination module — it `#include`s every subsystem and hosts functions that wire them together (command dispatch, document-open helpers, DDE handling, etc.).

---

## Component Map

### Document Engine Layer

All document-format support is provided through a common abstract interface defined in `src/EngineBase.h`. A concrete engine is selected by `src/EngineCreate.cpp` based on file extension / content sniffing.

| File | Engine | Formats |
|------|--------|---------|
| `src/EngineMupdf.cpp` | `EngineMupdf` | PDF, XPS, CBZ, FB2 (via MuPDF) |
| `src/EngineEbook.cpp` | `EngineEbook` | EPUB, MOBI, FB2, PDB, PalmDOC |
| `src/EngineImages.cpp` | `EngineImages` | PNG/JPEG/BMP/TIFF, CBZ, CBR, ImageDir |
| `src/EngineDjVu.cpp` | `EngineDjVu` | DjVu |
| `src/EnginePs.cpp` | `EnginePs` | PostScript (via Ghostscript) |
| `src/EngineCreate.cpp` | Factory | selects correct engine for a path |

**Key `EngineBase` operations used throughout the codebase:**

```cpp
// Page geometry
RectF  PageMediabox(int pageNo);
// Render a page to a bitmap
RenderedBitmap* RenderPage(RenderPageArgs& args);
// Extract all text with position data
PageText ExtractPageText(int pageNo);
// Build the table-of-contents tree
TocTree* GetToc();
// Get document metadata (title, author, …)
DocProperties* GetProperties();
```

### Rendering Pipeline

```
Canvas (Win32 WM_PAINT)
  └─ DisplayModel                  src/DisplayModel.cpp
       • page layout geometry
       • zoom / scroll state
       • visible-page list
         └─ RenderCache             src/RenderCache.cpp
              • background thread pool
              • bitmap tile cache
              • calls EngineBase::RenderPage()
```

- **`src/Canvas.cpp`** (2,470 lines) — The HWND that receives all mouse, keyboard, scroll, and paint messages. Delegates rendering to `DisplayModel` / `RenderCache` and forwards user actions to `SumatraPDF.cpp` command handlers.
- **`src/DisplayModel.cpp`** (2,015 lines) — Computes page positions, handles zoom levels, scroll offsets, and determines which pages are currently visible.
- **`src/RenderCache.cpp`** — Manages a background worker thread that pre-renders pages into bitmaps; caches results keyed by `(engine, pageNo, zoom, rotation)`.

### UI Layer

| File | Responsibility |
|------|---------------|
| `src/MainWindow.cpp/h` | Top-level `HWND` frame, houses toolbar + canvas + sidebar |
| `src/Canvas.cpp/h` | Document viewport (drawing surface + input handling) |
| `src/Toolbar.cpp/h` | Navigation / zoom toolbar |
| `src/Tabs.cpp/h` + `src/WindowTab.cpp/h` | Multi-document tab bar and per-tab state |
| `src/Menu.cpp/h` | Menu bar and context menus (2,296 lines) |
| `src/CommandPalette.cpp/h` | Keyboard-driven command launcher (1,340 lines) |
| `src/TableOfContents.cpp/h` | Collapsible TOC / bookmarks panel |
| `src/EditAnnotations.cpp/h` | PDF annotation editor panel |
| `src/HomePage.cpp/h` | Start/home page with recent files |
| `src/SumatraDialogs.cpp/h` | Common modal dialogs (go-to-page, find, properties…) |
| `src/wingui/` | Reusable Win32 widget wrappers (Wnd, Button, Edit, Checkbox, etc.) |

### Settings & Configuration

| File | Responsibility |
|------|---------------|
| `src/GlobalPrefs.cpp/h` | In-memory `GlobalPrefs` struct; serialised to `SumatraPDF-settings.txt` |
| `src/AppSettings.cpp/h` | Load / save application settings; file-watcher for live reload |
| `src/SumatraConfig.cpp/h` | Compile-time and ini-file configuration (`sumatrapdfrestrict.ini`) |
| `src/Theme.cpp/h` | Theme system (light/dark/custom colour schemes) |
| `src/AppColors.cpp/h` | Centralised colour palette used by all painting code |
| `src/FileHistory.cpp/h` | Recently-opened files list |
| `src/Favorites.cpp/h` | User bookmarks / favourites |
| `src/Flags.cpp/h` | Command-line flag definitions and `ParseFlags()` |

Settings are stored as a human-readable "SquareTree" text format in `%APPDATA%\SumatraPDF\SumatraPDF-settings.txt`.

### Utility Layer

All utilities live in `src/utils/` and avoid the STL in favour of custom containers:

| File | Responsibility |
|------|---------------|
| `BaseUtil.cpp/h` | Fundamental macros, `ReportIf`, memory helpers |
| `StrUtil.cpp/h` | String manipulation (no `std::string`) |
| `StrVec.cpp/h` / `Vec.h` | Dynamic arrays |
| `FileUtil.cpp/h` | File I/O helpers |
| `WinUtil.cpp/h` | Win32 API wrappers |
| `ThreadUtil.cpp/h` | Thread creation / synchronisation |
| `UITask.cpp/h` | Post tasks from background threads to the UI thread |
| `Log.cpp/h` | Structured logging (`logf`, `logfa`) |
| `Archive.cpp/h` | ZIP/RAR/7z archive access |
| `HtmlPullParser.cpp/h` | Streaming HTML parser (used by ebook engine) |
| `JsonParser.cpp/h` | JSON parser (used for update checks) |
| `GeomUtil.cpp/h` | Rect/Point/Size helpers |
| `GdiPlusUtil.cpp/h` | GDI+ wrapper (image scaling, colour conversion) |
| `CrashHandler.cpp/h` | Crash dump generation + upload |

### Accessibility

`src/uia/` implements the **UI Automation** provider hierarchy so screen readers (NVDA, JAWS, Narrator) can interact with document content:

- `Provider.cpp/h` — Root UIA provider for the document canvas
- `PageProvider.cpp/h` — Per-page text/element tree
- `StartPageProvider.cpp/h` — UIA tree for the home/start page

### Background / Async Services

| Mechanism | Purpose |
|-----------|---------|
| `RenderCache` worker thread | Pre-render page bitmaps off the UI thread |
| `UITask` queue | Safe cross-thread callbacks posted to the UI thread |
| `FileWatcher` | Watch settings file for changes and reload automatically |
| `UpdateCheck` async | Periodically poll for new releases in background |
| `StressTesting` (debug) | Automated torture test that opens many documents in sequence |
| Preview pipe server | Named-pipe IPC used by the shell previewer DLL |
| IFilter pipe server | Named-pipe IPC used by the Windows Search IFilter DLL |

---

## Key Execution Flows

### Opening a Document

```
User action (double-click / drag-drop / File→Open / DDE)
  │
  └─ LoadDocument()  [src/SumatraPDF.cpp]
       ├─ GuessFileType()         detect format
       ├─ EngineCreate()          instantiate correct engine
       ├─ new DisplayModel()      compute page layout
       ├─ new WindowTab()         create tab entry
       ├─ UpdateUiForCurrentTab() refresh toolbar / menu state
       └─ RenderCache::Render()   kick off background pre-render
```

### Page Rendering

```
RenderCache (background thread)
  ├─ EngineBase::RenderPage(pageNo, zoom, rotation)
  │    └─ [EngineMupdf] fz_run_page() via MuPDF
  ├─ stores RenderedBitmap* in cache map
  └─ UITask → Canvas::Repaint()

Canvas::WM_PAINT
  ├─ RenderCache::Find() → hit → BitBlt bitmap to screen
  └─ miss → draw placeholder / trigger async render
```

### Text Search

```
User types in Find toolbar
  └─ TextSearch::FindFirst() / FindNext()  [src/TextSearch.cpp]
       ├─ EngineBase::ExtractPageText(pageNo) → PageText
       ├─ string match (case / whole-word options)
       └─ TextSelection::SelectWords() → highlight rects
            └─ Canvas::Repaint() → draw selection overlays
```

### Printing

```
File → Print  (or -print-to command-line flag)
  └─ PrintFile() / PrintCurrentFile()  [src/Print.cpp]
       ├─ OpenPrinter() / CreateDC()
       ├─ for each page: EngineBase::RenderPage() at printer DPI
       └─ StartPage() / EndPage() via GDI print spooler
```

---

## ThinkPad-Specific Customisations

This fork differs from upstream SumatraPDF in the following ways (see `readme.md` and commit history):

| Change | Location | Notes |
|--------|----------|-------|
| Touchpad event sampling rate: 60 fps (was 5 fps) | `src/Canvas.cpp` | Smoother two-finger scrolling |
| Ctrl+Tab reverted to simple cycling | `src/Tabs.cpp` / `src/Canvas.cpp` | Removes smart-MRU Ctrl+Tab menu |
| Ctrl+1…9 switch tabs; Alt+1…9 zoom presets | `src/Commands.cpp` / `src/Accelerators.cpp` | Upstream used Ctrl+1…9 for zoom |
| Reduced horizontal scroll sensitivity | `src/Canvas.cpp` | Less accidental horizontal panning |
| Middle-mouse-button pan (like Fusion 360) | `src/Canvas.cpp` | Hold middle button and drag to pan |
| Background colour changed | `src/AppColors.cpp` | Hard-coded custom value |

---

## External Dependencies

All third-party code lives in `ext/` (and the vendored `mupdf/` tree). Versions are listed in `ext/versions.txt`.

| Library | Version | Purpose |
|---------|---------|---------|
| **MuPDF** | vendored | PDF/XPS rendering core |
| **freetype** | 2.13.3 | Font rasterisation |
| **harfbuzz** | 6.0.0 | Unicode text shaping |
| **libjpeg-turbo** | — | JPEG decode |
| **libwebp** | — | WebP decode |
| **libheif** | — | HEIF/AVIF decode |
| **zlib / zlib-ng** | — | Deflate compression |
| **bzip2** | 1.0.8 | BZ2 compression |
| **lzma** | — | LZMA/XZ compression |
| **openjpeg** | — | JPEG 2000 |
| **jbig2dec** | 0.18 | JBIG2 image compression |
| **lcms2** | — | ICC colour management |
| **libdjvu** | — | DjVu format support |
| **mujs** | — | JavaScript engine (PDF forms) |
| **gumbo-parser** | — | HTML5 parsing |
| **unarr** | — | ZIP/RAR/7z archive extraction |
| **unrar** | — | RAR-specific extraction |
| **CHMLib** | 0.40a | CHM/HtmlHelp format |
| **synctex** | — | TeX↔PDF source sync |
| **darkmodelib** | — | Windows 10/11 dark-mode support |
| **WebView2** | NuGet | In-app browser (about/help pages) |

---

## Build Instructions

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Windows 10/11** | — | Target platform; build must run on Windows |
| **Visual Studio 2022** | 17.x | C++ workload + Windows SDK required |
| **Bun** | ≥ 1.0 | JavaScript runtime for `cmd/*.ts` scripts |
| **Premake5** | 5.x | Only needed if regenerating VS project files |

### Quick build (debug, x64)

```powershell
# From the repository root
bun ./cmd/build.ts
```

This runs:
```
msbuild .\vs2022\SumatraPDF.sln /t:SumatraPDF /p:Configuration=Debug;Platform=x64 /m
```

Output binary: `out/dbg64/SumatraPDF.exe`

### Other build variants

```powershell
# Line-of-code statistics
bun ./cmd/build.ts -wc

# Fix residual "virtual ... override" style issues in source
bun ./cmd/build.ts -fix-virt

# Regenerate Visual Studio project files (requires premake5.exe in PATH)
bun ./cmd/premake.ts

# Run automated tests
bun ./cmd/run-tests.ts

# Clang-tidy static analysis
bun ./cmd/clang-tidy.ts

# Clean build artefacts
bun ./cmd/clean.ts
```

### Regenerating VS projects

If `premake5.lua` or `premake5.files.lua` are modified, regenerate the solution:

```powershell
premake5 vs2022
```

---

## Running & Debugging Locally

### Run

```powershell
.\out\dbg64\SumatraPDF.exe
# or open a specific file:
.\out\dbg64\SumatraPDF.exe path\to\document.pdf
```

### Debug with WinDbg

```powershell
windbgx -Q -o -g .\out\dbg64\SumatraPDF.exe
```

### Useful command-line flags

| Flag | Effect |
|------|--------|
| `-console` | Attach a console window for log output |
| `-log` | Write log to `%TEMP%\sumatrapdf.log` |
| `-bench <path>` | Benchmark rendering of a file |
| `-engine-dump <path>` | Dump engine internals to stdout |
| `-stress-test <path>` | Open files repeatedly (automated stress test) |
| `-restrict` | Run in restricted/kiosk mode |
| `-new-window` | Force opening a new window instead of reusing existing |

### Settings file location

```
%APPDATA%\SumatraPDF\SumatraPDF-settings.txt
```

Edit this file (plain text) to customise advanced settings documented in [docs/md/Advanced-options-settings.md](md/Advanced-options-settings.md).

### Restriction / kiosk policy

Create `sumatrapdfrestrict.ini` alongside the executable (see `docs/sumatrapdfrestrict.ini` for the template) to lock down functionality in managed environments.
