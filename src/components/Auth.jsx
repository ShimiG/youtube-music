import { useState } from 'react'
import '../styles/Auth.css'

function Auth({ onLoginSuccess }) {
  const [action, setAction] = useState('login') // 'login' or 'register'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const response = await fetch(`/auth/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })

      const data = await response.json()

      if (response.ok) {
        if (action === 'register') {
          setMessage('✓ Registration successful! Please log in.')
          setAction('login')
          setPassword('')
        } else {
          // LOGIN SUCCESS
          onLoginSuccess(data.token, data.username)
        }
      } else {
        setMessage(data.error || 'Auth failed')
      }
    } catch (error) {
      console.error(error)
      setMessage('Server Error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>🎵 Music Library</h1>
        <h2>{action === 'login' ? 'Login' : 'Register'}</h2>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              required
            />
          </div>

          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
            />
          </div>

          <button type="submit" disabled={loading}>
            {loading ? 'Loading...' : action === 'login' ? 'Login' : 'Register'}
          </button>
        </form>

        {message && (
          <p className={`message ${action === 'register' && message.includes('✓') ? 'success' : 'error'}`}>
            {message}
          </p>
        )}

        <p className="toggle-action">
          {action === 'login' ? (
            <>
              Don't have an account?{' '}
              <button type="button" onClick={() => setAction('register')}>
                Register
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button type="button" onClick={() => setAction('login')}>
                Login
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

export default Auth
