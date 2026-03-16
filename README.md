Here is the updated `README.md` that reflects your massive architectural shift to a Tauri desktop application, the SQLite database implementation, the testing suites, and your new robust streaming cache pipeline!

```markdown
# Hybrid Cross-Platform Music Manager

A unified, full-stack music streaming application designed to bridge disparate music ecosystems. Originally built as a web application, it has evolved into a highly optimized, native desktop application using Tauri and Rust. Currently built on top of the YouTube Data API v3 with a robust custom streaming pipeline, the application allows users to search, manage playlists, and stream audio through a highly optimized React frontend.

## Architecture & API Roadmap

View the full system architecture, API data flow, and divergent streaming strategy diagram here:  
**[Eraser.io Architecture Diagram](https://app.eraser.io/workspace/xs7pg6H8yMwvnJquAMfJ)**

## Key Features (Phase 3 Complete)

### 🖥️ Native Desktop Experience (New!)
* **Tauri Core:** The React frontend and Node.js backend are bundled into a lightweight, incredibly fast native desktop executable using Tauri and Rust.
* **Node.js Sidecar:** The Express backend is pre-compiled into a standalone binary using `pkg` and runs securely as a background sidecar process.
* **System Tray Integration:** Minimizing or closing the window hides the app to the system tray, allowing music to continue playing seamlessly in the background.

### 🎵 Advanced Playback Engine
* **Bulletproof Audio Caching:** Streams are dynamically piped using `ffmpeg` and saved locally using a `.part` file chunking pattern, allowing for instant seeks and offline caching without broken streams or memory leaks. 
* **Gapless Preloading:** A hidden background engine listens for the `progress` event of the active track and silently preloads the next song in the queue into the browser's RAM, ensuring zero-latency, gapless transitions.
* **OS Media Controls:** Full integration with the **Media Session API**. Control playback, skip tracks, and view album art directly from your Mac Control Center, Windows Media Overlay, or mobile lock screen.

### 🗄️ Library & Database Management (New!)
* **Local SQLite Database:** Fully functional local database for lightning-fast, offline-capable storage of custom user playlists, track history, and a universal song registry.
* **My Library:** Authenticated OAuth users can fetch their personal YouTube playlists, view precise song counts, and drill down into playlist contents.
* **Intelligent Shuffle:** Uses the Fisher-Yates algorithm to randomize the upcoming queue while perfectly retaining the currently playing song. Toggling shuffle off instantly restores the original playlist order.

### 🎨 Premium UI/UX
* **Responsive Dashboard:** A dark-mode, edge-to-edge layout built with CSS Grid/Flexbox inspired by modern streaming giants.
* **Custom SVG Controls:** Buttery smooth CSS transitions, hover states, and a fully custom SVG volume slider featuring animated sound waves that react to mute states.

## Tech Stack

**Frontend & Desktop Wrapper:**
* React.js (Vite)
* Tauri (Rust) for native OS integrations and window management
* Context API (Global Audio & Queue State)
* HTML5 Audio API (Native Buffering & Playback)

**Backend & Data Layer:**
* Node.js & Express (Architected with the Controller/Router pattern)
* Local SQLite3 Database
* `yt-dlp` + `ffmpeg` (Raw audio extraction and ADTS streaming pipeline)
* `googleapis` (Official YouTube Data v3 API for metadata)
* `pkg` (Compiles Node.js backend into standalone executables)
* Jest & Supertest (Comprehensive endpoint and database mocking test suites)

## Getting Started

### Prerequisites
* Node.js (v18+)
* Rust and `rustup` installed (for Tauri)
* `ffmpeg` and `yt-dlp` installed on your system
* Google Cloud Console Project with YouTube Data API v3 enabled and OAuth credentials

### Installation & Development
1. Clone the repository.
2. Install all dependencies from the root directory:
   ```bash
   npm install

```

3. Create a `.env` file in the root directory with your Google API credentials and session secrets.
4. Run the development server (This automatically spins up both the Node.js backend and the React/Tauri frontend concurrently):
```bash
npx tauri dev

```



### Building for Production

To build the standalone desktop executables (.dmg, .exe, .app):

```bash
npm run tauri:build

```

## Roadmap: Phase 4 (Upcoming)

* **Custom Window Styling:** Removing default OS title bars in favor of a custom React drag-bar.
* **Spotify Integration:** Implementing the Spotify Web Playback SDK to allow hybrid YouTube/Spotify queues.

```

**Changes Made:**
1. **Moved Phase 3 from the roadmap to "Complete"**, specifically highlighting the Tauri desktop migration, SQLite database integration, and the backend Controller refactor.
2. Added the **Native Desktop Experience** section to highlight the System Tray, Sidecar, and Rust integrations.
3. Updated the **Tech Stack** to include Tauri, SQLite, `pkg`, and Jest.
4. Streamlined the **Installation** instructions to reflect your new, clean `package.json` where `npx tauri dev` handles both the client and server!

```