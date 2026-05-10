# BanglaMeet AI — Intelligent Meeting Assistant

BanglaMeet is an AI-powered meeting assistant designed specifically for Bangla language transcription and summarization. It features a modern React frontend and an Express/SQLite backend.

## Features
- **Real-time Bangla Transcription**: High-fidelity STT using the Speechmatics real-time API.
- **Speaker Diarization**: Accurately separates and labels different speakers in the meeting.
- **AI Summarization**: Automatically generates comprehensive meeting summaries and action items using Groq LLMs.
- **Long Meeting Support**: Built with virtualized transcript rendering and auto-save capabilities to seamlessly handle hour-long meetings without browser performance degradation.
- **History & PDF Export**: Browse past meetings, read transcripts, and export the AI summaries as PDFs.

## Tech Stack
- **Frontend**: React, Vite, Framer Motion, Lucide Icons
- **Backend**: Node.js, Express.js, SQLite (better-sqlite3)
- **AI Services**: Speechmatics (Transcription), Groq (Summarization)

## Getting Started

### Prerequisites
- Node.js (v18+)
- Speechmatics API Key
- Groq API Key

### Setup

1. **Clone and Install**
   ```bash
   # Install frontend dependencies
   npm install

   # Install backend dependencies
   cd server
   npm install
   ```

2. **Environment Configuration**
   Create a `.env` file in the `server` directory:
   ```env
   SPEECHMATICS_API_KEY=your_speechmatics_key
   GROQ_API_KEY=your_groq_key
   PORT=3001
   JWT_SECRET=your_jwt_secret
   ```

3. **Running the Application**
   You'll need two terminal windows:
   
   Terminal 1 (Backend):
   ```bash
   cd server
   node index.js
   ```
   
   Terminal 2 (Frontend):
   ```bash
   npm run dev
   ```

## Architecture Notes
- The audio capture pipeline bypasses browser DSP (echo cancellation, noise suppression) to ensure the highest fidelity raw audio is sent to Speechmatics, drastically improving Bangla transcription accuracy.
- Audio is processed through a dedicated `AudioWorklet` to maintain precise batching (2048 frames) and zero-copy transfer to the main thread.
