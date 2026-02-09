import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { MusicProvider } from './context/MusicContext.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MusicProvider>
      <App />
    </MusicProvider>
  </React.StrictMode>,
)