const app = require('./app');
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    try {
        const open = require('open');
        await open(`http://localhost:${PORT}`);
    } catch (e) {
        // Ignore
    }
});