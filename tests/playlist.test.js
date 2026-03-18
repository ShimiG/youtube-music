const request = require('supertest');
const app = require('../app');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn()
};

app.locals.db = mockDb;

describe('Custom Playlist API Endpoints', () => {
  
    beforeEach(() => {
        jest.resetAllMocks();
    });

    describe('POST /api/custom-playlists', () => {
        it('should create a new playlist and return 201', async () => {
            mockDb.get.mockResolvedValueOnce({ id: 1 }); 
            mockDb.run.mockResolvedValueOnce({ lastID: 10 });

            const res = await request(app)
                .post('/api/custom-playlists')
                .set('x-user-id', '1')
                .send({ name: 'Coding Focus', thumbnail: 'http://image.com/img.jpg' });

            expect(res.statusCode).toEqual(201);
            expect(res.body).toHaveProperty('id', 10);
            expect(res.body).toHaveProperty('name', 'Coding Focus');
        });

        it('should return 404 if the user is not found in the database', async () => {
            mockDb.get.mockResolvedValueOnce(null); 

            const res = await request(app)
                .post('/api/custom-playlists')
                .set('x-user-id', '1')
                .send({ name: 'Ghost Playlist' });

            expect(res.statusCode).toEqual(404);
            expect(res.body).toHaveProperty('error', 'User not found in DB');
        });
    });

    describe('GET /api/custom-playlists', () => {
        it('should return a list of custom playlists for the user', async () => {
            const fakePlaylists = [
                { id: 1, name: 'Gym Mix', itemCount: 12 },
                { id: 2, name: 'Chill', itemCount: 5 }
            ];
            mockDb.all.mockResolvedValueOnce(fakePlaylists);

            const res = await request(app)
                .get('/api/custom-playlists')
                .set('x-user-id', '1');

            expect(res.statusCode).toEqual(200);
            expect(res.body).toHaveLength(2);
            expect(res.body[0].name).toEqual('Gym Mix');
        });
    });

    describe('POST /api/custom-playlists/:id/tracks', () => {
        it('should successfully add a track to the universal registry and playlist', async () => {
            mockDb.get.mockResolvedValueOnce({ id: 1 }); 
            mockDb.run.mockResolvedValueOnce({}); 
            mockDb.get.mockResolvedValueOnce({ id: 99 }); 
            mockDb.run.mockResolvedValueOnce({}); 

            const res = await request(app)
                .post('/api/custom-playlists/10/tracks')
                .send({
                    sourceName: 'youtube',
                    externalId: 'dQw4w9WgXcQ',
                    title: 'Never Gonna Give You Up',
                    artist: 'Rick Astley'
                });

            expect(res.statusCode).toEqual(201);
            expect(res.body).toHaveProperty('success', true);
            expect(mockDb.get).toHaveBeenCalledTimes(2);
            expect(mockDb.run).toHaveBeenCalledTimes(2);
        });

        it('should reject invalid source names gracefully', async () => {
            mockDb.get.mockResolvedValueOnce(null);

            const res = await request(app)
                .post('/api/custom-playlists/10/tracks')
                .send({
                    sourceName: 'limewire',
                    externalId: '123',
                    title: 'Hacked Song'
                });

            expect(res.statusCode).toEqual(400);
            expect(res.body).toHaveProperty('error', 'Invalid source');
        });
    });

    describe('GET /api/custom-playlists/:id/tracks', () => {
        it('should return tracks sorted correctly', async () => {
            const fakeTracks = [
                { id: 'xyz', title: 'Song 1', source: 'youtube' },
                { id: 'abc', title: 'Song 2', source: 'youtube' }
            ];
            mockDb.all.mockResolvedValueOnce(fakeTracks);

            const res = await request(app).get('/api/custom-playlists/10/tracks');

            expect(res.statusCode).toEqual(200);
            expect(res.body).toHaveLength(2);
            expect(res.body[1].title).toEqual('Song 2');
        });
    });
});