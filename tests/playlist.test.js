const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');

const validToken = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${validToken}` };

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn()
};

app.locals.db = mockDb;

describe('Custom Playlist API (authenticated)', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    describe('POST /api/custom-playlists', () => {
        it('creates a playlist for the logged-in user and returns 201', async () => {
            mockDb.run.mockResolvedValueOnce({ lastID: 10 });

            const res = await request(app)
                .post('/api/custom-playlists')
                .set(auth)
                .send({ name: 'Coding Focus', thumbnail: 'http://image.com/img.jpg' });

            expect(res.statusCode).toBe(201);
            expect(res.body).toHaveProperty('id', 10);
            expect(res.body).toHaveProperty('name', 'Coding Focus');
            // The playlist must be inserted against the token's userId (1), not any client input.
            expect(mockDb.run.mock.calls[0][1][0]).toBe(1);
        });

        it('rejects an empty playlist name with 400', async () => {
            const res = await request(app).post('/api/custom-playlists').set(auth).send({ name: '' });
            expect(res.statusCode).toBe(400);
        });
    });

    describe('GET /api/custom-playlists', () => {
        it('returns the current user playlists', async () => {
            mockDb.all.mockResolvedValueOnce([
                { id: 1, name: 'Gym Mix', itemCount: 12 },
                { id: 2, name: 'Chill', itemCount: 5 }
            ]);

            const res = await request(app).get('/api/custom-playlists').set(auth);

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveLength(2);
            expect(res.body[0].name).toBe('Gym Mix');
            // The query must be scoped to the token's userId.
            expect(mockDb.all.mock.calls[0][1]).toEqual([1]);
        });
    });

    describe('POST /api/custom-playlists/:playlistId/tracks', () => {
        it('adds a track when the playlist belongs to the user', async () => {
            mockDb.get
                .mockResolvedValueOnce({ id: 10 })   // ownership check passes
                .mockResolvedValueOnce({ id: 1 })    // source lookup
                .mockResolvedValueOnce({ id: 99 });  // track lookup
            mockDb.run.mockResolvedValue({});

            const res = await request(app)
                .post('/api/custom-playlists/10/tracks')
                .set(auth)
                .send({ sourceName: 'youtube', externalId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley' });

            expect(res.statusCode).toBe(201);
            expect(res.body).toHaveProperty('success', true);
        });

        it('returns 404 when the playlist does not belong to the user', async () => {
            mockDb.get.mockResolvedValueOnce(undefined); // ownership check fails

            const res = await request(app)
                .post('/api/custom-playlists/10/tracks')
                .set(auth)
                .send({ sourceName: 'youtube', externalId: '123', title: 'Song' });

            expect(res.statusCode).toBe(404);
        });

        it('rejects an unknown source with 400', async () => {
            mockDb.get
                .mockResolvedValueOnce({ id: 10 })   // ownership passes
                .mockResolvedValueOnce(undefined);   // source not found

            const res = await request(app)
                .post('/api/custom-playlists/10/tracks')
                .set(auth)
                .send({ sourceName: 'limewire', externalId: '123', title: 'Hacked Song' });

            expect(res.statusCode).toBe(400);
            expect(res.body).toHaveProperty('error', 'Invalid source');
        });
    });

    describe('GET /api/custom-playlists/:playlistId/tracks', () => {
        it('returns tracks when the playlist belongs to the user', async () => {
            mockDb.get.mockResolvedValueOnce({ id: 10 }); // ownership passes
            mockDb.all.mockResolvedValueOnce([
                { id: 'xyz', title: 'Song 1', source: 'youtube' },
                { id: 'abc', title: 'Song 2', source: 'youtube' }
            ]);

            const res = await request(app).get('/api/custom-playlists/10/tracks').set(auth);

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveLength(2);
        });

        it('returns 404 for a playlist the user does not own', async () => {
            mockDb.get.mockResolvedValueOnce(undefined);
            const res = await request(app).get('/api/custom-playlists/99/tracks').set(auth);
            expect(res.statusCode).toBe(404);
        });
    });
});
