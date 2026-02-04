# Music Manager

A web-based music player application that integrates with YouTube to stream audio, manage playlists, and control playback queues. Built with Node.js, Express, and Vanilla JavaScript.

## Features

* **YouTube Integration:** Search for songs and stream audio directly from YouTube.
* **User Library:** Log in with Google to access your YouTube Playlists and "Liked" videos.
* **Smart Queue System:** Full "History" and "Up Next" queue management with shuffle-free navigation.
* **Playback Controls:** Play, Pause, Next, Previous, and Queue management.
* **Responsive UI:** Features a sidebar navigation and an expandable "Now Playing" drawer that reveals high-quality album art and the current queue.
* **Authentication:** Secure OAuth2 login with auto-token refreshing.

## Prerequisites

Before running the application, ensure you have the following installed:

* [Node.js](https://nodejs.org/) (v14 or higher)
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
    * Create a folder named `bin` in the root of your project.
    * Download the latest release of `yt-dlp` for your OS from [GitHub Releases](https://github.com/yt-dlp/yt-dlp/releases).
    * **Windows:** Rename the file to `yt-dlp.exe` and place it in `/bin`.
    * **Mac/Linux:** Rename the file to `yt-dlp`, place it in `/bin`, and run `chmod +x bin/yt-dlp`.

4.  **Environment Configuration:**
    Create a `.env` file in the root directory and add your Google API credentials:

    ```env
    PORT=3000
    GOOGLE_CLIENT_ID=your_google_client_id
    GOOGLE_CLIENT_SECRET=your_google_client_secret
    REDIRECT_URI=http://localhost:3000/auth/google/callback
    ```

## Usage

1.  **Start the server:**
    ```bash
    npm start
    ```

2.  **Open the application:**
    Open your browser and navigate to: `http://localhost:3000`

3.  **Log In:**
    Click the "Login with Google" button to authorize access to your YouTube account.

## Project Structure

* **`server.js`**: Main entry point for the Express server.
* **`routes/`**: API route definitions (`auth.js`, `playlist.js`, `search.js`).
* **`controllers/`**: Backend logic for handling API requests and streaming.
* **`public/`**: Frontend assets.
    * `index.html`: Main UI structure.
    * `js/PlayerManager.js`: Core logic for queue, history, and UI state.
    * `js/YouTubeAdapter.js`: Handles HTML5 audio playback.

## Troubleshooting

* **Audio not playing / "Spawn Error":**
    Ensure the `yt-dlp` binary is in the `bin` folder and has the correct permissions.

* **"Signature solving failed" (Console Log):**
    YouTube updates their code frequently. If streams stop working, download the latest `yt-dlp` binary and replace the old one in your `bin` folder.

* **"Invalid Authentication Credentials":**
    If you see 401 errors, try logging out and logging back in. The application handles token refreshing automatically, but a clean login resolves most permission issues.

## License

[MIT](https://choosealicense.com/licenses/mit/)
