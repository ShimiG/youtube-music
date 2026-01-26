import { useState } from 'react'
import '../styles/SearchMusic.css'

function SearchMusic({ token }) {
  const [query, setQuery] = useState('')
  const [videos, setVideos] = useState([])
  const [loading, setLoading] = useState(false)
  const [savedSongs, setSavedSongs] = useState(new Set())

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!query.trim()) return

    setLoading(true)
    try {
      const response = await fetch(`/search?q=${encodeURIComponent(query)}`)
      
      if (!response.ok) throw new Error('Search failed')
      
      const data = await response.json()
      setVideos(data.items || [])
    } catch (error) {
      console.error(error)
      alert('Error fetching songs')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (video) => {
    try {
      const response = await fetch('/playlist/add', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token
        },
        body: JSON.stringify({
          title: video.snippet.title,
          youTubeId: video.id.videoId,
          channelTitle: video.snippet.channelTitle,
          thumbnailUrl: video.snippet.thumbnails.default.url
        })
      })

      if (response.ok) {
        setSavedSongs(new Set([...savedSongs, video.id.videoId]))
      } else {
        alert('Failed to save song')
      }
    } catch (error) {
      console.error(error)
    }
  }

  return (
    <div className="search-container">
      <h2>🔍 Search Music</h2>

      <form onSubmit={handleSearch} className="search-form">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a song (e.g. Linkin Park)"
          className="search-input"
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      <div className="results-container">
        {videos.map((video) => {
          if (!video.id.videoId) return null
          const isSaved = savedSongs.has(video.id.videoId)

          return (
            <div key={video.id.videoId} className="result-item">
              <img
                src={video.snippet.thumbnails.default.url}
                alt={video.snippet.title}
                className="result-thumbnail"
              />
              <div className="result-info">
                <h4>{video.snippet.title}</h4>
                <p className="channel-name">{video.snippet.channelTitle}</p>
                <div className="result-actions">
                  <a
                    href={`https://www.youtube.com/embed/${video.id.videoId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-play"
                  >
                    ▶ Play
                  </a>
                  <button
                    onClick={() => handleSave(video)}
                    disabled={isSaved}
                    className={`btn ${isSaved ? 'btn-saved' : 'btn-add'}`}
                  >
                    {isSaved ? '✔ Saved' : '✚ Add to Library'}
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default SearchMusic
