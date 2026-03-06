# Hybrid Cross-Platform Music Manager

A unified, full-stack music streaming application designed to bridge disparate music ecosystems. Currently built on top of the YouTube Data API v3 with a robust custom streaming pipeline, the application allows users to search, manage playlists, and stream audio through a highly optimized React frontend.

## Architecture & API Roadmap

View the full system architecture, API data flow, and divergent streaming strategy diagram here:  
**[Eraser.io Architecture Diagram](https://app.eraser.io/workspace/xs7pg6H8yMwvnJquAMfJ)**

## Key Features (Phase 2 Complete)

### Advanced Playback Engine
* **Gapless Preloading:** A hidden background engine listens for the `progress` event of the active track and silently preloads the next song in the queue into the browser's RAM, ensuring zero-latency, gapless transitions.
* **Smart Audio Caching:** Dragging the seek bar calculates if the target timestamp exists in the browser's native `<audio>` buffer. If yes, it performs an instant "Native Seek" without hitting the server.
* **OS Media Controls:** Full integration with the **Media Session API**. Control playback, skip tracks, and view album art directly from your Mac Control Center, Windows Media Overlay, or mobile lock screen.

### Library & Queue Management
* **My Library:** Authenticated OAuth users can fetch their personal YouTube playlists, view precise song counts, and drill down into playlist contents.
* **Intelligent Shuffle:** Uses the Fisher-Yates algorithm to randomize the upcoming queue while perfectly retaining the currently playing song. Toggling shuffle off instantly restores the original playlist order.
* **"Play All" & Queueing:** Instantly clear the queue and play a full playlist, or silently queue tracks up next.

### Premium UI/UX
* **Responsive Dashboard:** A dark-mode, edge-to-edge layout built with CSS Grid/Flexbox inspired by modern streaming giants.
* **Custom SVG Controls:** Buttery smooth CSS transitions, hover states, and a fully custom SVG volume slider featuring animated sound waves that react to mute states.

## Tech Stack

**Frontend:**
* React.js (Vite)
* Context API (Global Audio & Queue State)
* HTML5 Audio API (Native Buffering & Playback)

**Backend:**
* Node.js & Express
* `yt-dlp` + `ffmpeg` (Raw audio extraction and ADTS streaming pipeline)
* `googleapis` (Official YouTube Data v3 API for metadata)
* OAuth 2.0 (Persistent background authentication)

## Getting Started

### Prerequisites
* Node.js (v18+)
* `ffmpeg` and `yt-dlp` installed on your system
* Google Cloud Console Project with YouTube Data API v3 enabled and OAuth credentials

### Installation
1. Clone the repository.
2. Install backend dependencies:
   ```bash
   cd server
   npm install
 3. Install frontend dependencies:
    ```bash
    cd client
    npm install
4. Create a .env file in the root of the server directory with your Google API credentials and session secrets.
5. Start the backend (npm start) and frontend (npm run dev).

6. Roadmap: Phase 3 (Upcoming)
Backend Refactor: Decoupling routing from business logic (Transitioning to /routes, /controllers, and /services).

Database Integration: Provisioning PostgreSQL/MongoDB for persistent cross-platform playlist storage.

Spotify Integration: Implementing the Spotify Web Playback SDK to allow hybrid YouTube/Spotify queues.
