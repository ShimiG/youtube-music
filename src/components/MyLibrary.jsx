import { useState, useEffect } from 'react'
import '../styles/MyLibrary.css'

function MyLibrary({ token }) {
  const [songs, setSongs] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    loadLibrary()
  }, [token])

  const loadLibrary = async () => {
    setLoading(true)
    try {
      const response = await fetch('/playlist', {
        headers: {
          'Authorization': token
        }
      })

      if (!response.ok) throw new Error('Failed to load library')
      
      const data = await response.json()
      setSongs(data)
    } catch (error) {
      console.error(error)
      alert('Error loading library')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (songId) => {
    if (!confirm('Are you sure you want to delete this song?')) return

    try {
      const response = await fetch(`/playlist/${songId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': token
        }
      })

      if (response.ok) {
        setSongs(songs.filter(s => s._id !== songId))
      } else {
        alert('Failed to delete song')
      }
    } catch (error) {
      console.error(error)
    }
  }

  return (
    <div className="library-container">
      <h2>📂 My Library</h2>
      
      <button onClick={loadLibrary} disabled={loading} className="refresh-btn">
        {loading ? 'Loading...' : '🔄 Refresh'}
      </button>

      <div className="songs-container">
        {songs.length === 0 ? (
          <p className="empty-message">No songs saved yet. Search and add some!</p>
        ) : (
          songs.map((song) => (
            <div key={song._id} className="song-item">
              <img
                src={song.thumbnailUrl || 'https://via.placeholder.com/120'}
                alt={song.title}
                className="song-thumbnail"
              />
              <div className="song-info">
                <h4>{song.title}</h4>
                <p className="artist-name">{song.channelTitle}</p>
                <div className="song-actions">
                  <a
                    href={`https://www.youtube.com/embed/${song.youTubeId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-play"
                  >
                    ▶ Play
                  </a>
                  <button
                    onClick={() => handleDelete(song._id)}
                    className="btn btn-delete"
                  >
                    🗑 Delete
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default MyLibrary
