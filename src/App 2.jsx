import { useState, useEffect } from 'react'
import Auth from './components/Auth'
import SearchMusic from './components/SearchMusic'
import MyLibrary from './components/MyLibrary'
import './App.css'

function App() {
  const [token, setToken] = useState(null)
  const [username, setUsername] = useState(null)

  useEffect(() => {
    // Check if token exists in localStorage on mount
    const savedToken = localStorage.getItem('userToken')
    if (savedToken) {
      setToken(savedToken)
      setUsername(localStorage.getItem('username') || 'User')
    }
  }, [])

  const handleLoginSuccess = (authToken, user) => {
    localStorage.setItem('userToken', authToken)
    localStorage.setItem('username', user)
    setToken(authToken)
    setUsername(user)
  }

  const handleLogout = () => {
    localStorage.removeItem('userToken')
    localStorage.removeItem('username')
    setToken(null)
    setUsername(null)
  }

  if (!token) {
    return <Auth onLoginSuccess={handleLoginSuccess} />
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>🎵 YouTube Music Library</h1>
        <div className="header-info">
          <span>Welcome, {username}!</span>
          <button onClick={handleLogout} className="logout-btn">Logout</button>
        </div>
      </header>

      <main className="app-main">
        <div className="tabs-container">
          <SearchMusic token={token} />
          <MyLibrary token={token} />
        </div>
      </main>
    </div>
  )
}

export default App
