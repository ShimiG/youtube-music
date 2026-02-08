# Music Manager

A web-based music player application that integrates with YouTube to stream audio, manage playlists, and control playback queues. Built with Node.js, Express, and Vanilla JavaScript.

## Features

* **YouTube Integration:** Search for songs and stream audio directly from YouTube.
* **User Library:** Log in with Google to access your YouTube Playlists and "Liked" videos.
* **Smart Queue System:** Full "History" and "Up Next" queue management with shuffle-free navigation.
* **Playback Controls:** Play, Pause, Next, Previous, Scrubbing, Volume, Shuffle, and Repeat.
* **Native Integration:** Supports media keys (Play/Pause) and OS-level media sessions (displays album art in system menus).
* **Responsive UI:** Features a sidebar navigation and an expandable "Now Playing" drawer.
* **Security:** Built-in rate limiting, secure headers (Helmet), and strict input validation.
* **CI/CD:** Automated testing and build pipeline for Windows executables.

---

## Project Roadmap

### ✅ Phase 1: Core & Backend (Completed)
- [x] Basic Streaming Engine (Node.js + yt-dlp)
- [x] Queue Management (History, Up Next, Shuffle, Repeat)
- [x] Native Media Session Integration (Hardware Media Keys)
- [x] Security Hardening (Input Validation, Rate Limiting, Helmet)
- [x] Automated Builds (GitHub Actions -> .exe generation)
- [x] CI/CD Pipeline (Automated Testing on Push)

### 🚧 Phase 2: Frontend Modernization (Next Up)
- [ ] Migrate frontend from Vanilla JS to **React.js**
- [ ] State Management (Redux or Context API)
- [ ] Component-based UI Architecture
- [ ] Improved Error Handling & User Feedback (Toasts)

### 🔮 Phase 3: Advanced Features
- [ ] User Accounts & Database (MongoDB/PostgreSQL)
- [ ] Custom Playlists (Not synced with YouTube)
- [ ] Lyrics Integration
- [ ] Social Features (Share queues, collaborative listening)

### 🖥️ Phase 4: Desktop Application
- [ ] Wrap application in **Electron** or **Tauri**
- [ ] Offline Mode (Caching songs to disk)
- [ ] Discord Rich Presence Integration

---

## Prerequisites

Before running the application, ensure you have the following installed:

* [Node.js](https://nodejs.org/) (v18 or higher)
* A Google Cloud Project with the **YouTube Data API v3** enabled.

## Installation

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd <your-project-folder>
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Setup yt-dlp:**
    This project requires the `yt-dlp` binary to handle audio streaming.
    * **Automatic:** The project includes scripts to attempt automatic setup, but manual is recommended for stability.
    * **Manual:**
        * Create a folder named `bin` in the root of your project.
        * Download the latest release of `yt-dlp` from [GitHub Releases](https://github.com/yt-dlp/yt-dlp/releases).
        * **Windows:** Rename to `yt-dlp.exe` and place in `/bin`.
        * **Mac/Linux:** Rename to `yt-dlp`, place in `/bin`, and run `chmod +x bin/yt-dlp`.

4.  **Environment Configuration:**
    Create a `.env` file in the root directory and add your Google API credentials:

    ```env
    PORT=3000
    GOOGLE_CLIENT_ID=your_google_client_id
    GOOGLE_CLIENT_SECRET=your_google_client_secret
    REDIRECT_URI=http://localhost:3000/auth/google/callback
    ```

## Usage

### Development Mode
1.  **Start the server:**
    ```bash
    npm start
    ```
2.  **Open the application:**
    Open your browser and navigate to: `http://localhost:3000`

### Building for Windows
To create a standalone `.exe` file:
```bash
npm run build
