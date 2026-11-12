import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { MusicProvider } from './context/MusicContext.jsx'
import ServerGate from './components/ServerGate.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ServerGate>
      <MusicProvider>
        <App />
      </MusicProvider>
    </ServerGate>
  </React.StrictMode>,
)