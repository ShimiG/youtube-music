const mongoose = require('mongoose');

const songSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  artist: {
    type: String,
    required: true
  },
  duration: {
    type: Number,
    required: true
  },
  youTubeId: {
    type: String,
    required: true
  },
  thumbnailUrl: String,
  genre: String,
  releaseDate: Date,
  createdAt: {
    type: Date,
    default: Date.now
  },
    owner: {
        type: mongoose.Schema.Types.ObjectId, // This is a special MongoDB type
        ref: 'User', // It points to the 'User' model
        required: true
    }
});

module.exports = mongoose.model('Song', songSchema);