require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet'); 
const rateLimit = require('express-rate-limit'); 


const { streamAudio } = require('./controllers/playController');


const searchRoute = require('./routes/search');
const authRoutes = require('./routes/auth');
const playlistRoutes = require('./routes/playlist');

const app = express();

app.use(express.json()); 
app.use(cors());         

app.use(helmet({
    contentSecurityPolicy: false, 
}));

app.use(express.static('public'));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: "Too many requests from this IP, please try again later."
});


const validateVideoId = (req, res, next) => {

    const videoId = req.query.videoId || req.body.videoId;


    const isValid = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId);

    if (!isValid) {
        console.error(`Blocked malicious/invalid request: ${videoId}`);
        return res.status(400).send("Invalid Video ID");
    }
    
    next();
};

app.get('/test', (req, res) => {
    console.log("Server is working!");
    res.send("Server is working!");
});

app.use('/search', searchRoute);
app.use('/playlist', playlistRoutes);
app.use('/auth', authRoutes);

app.get('/play', limiter, validateVideoId, streamAudio);

app.get('/', (req, res) => {
    res.json({ 
        status: "Running", 
        message: "Music Backend is active",
        timestamp: new Date()
    });
});
module.exports = app;