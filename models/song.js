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
  duration: {
     type: Number, 
     required: true 
  },
  genre: String,
  releaseDate: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }

});

module.exports = mongoose.model('Song', songSchema);