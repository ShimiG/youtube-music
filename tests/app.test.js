const request = require('supertest');
const app = require('../app');

describe('Sanity Checks', () => {
    
    it('GET / should return 200 and serve JSON status', async () => {
        const res = await request(app).get('/');
        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('application/json');
        expect(res.body.status).toEqual('Running');
    });

    it('GET /test should return 200', async () => {
        const res = await request(app).get('/test');
        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('Server is working!');
    });

    it('GET /random-route should return 404', async () => {
        const res = await request(app).get('/this-does-not-exist');
        expect(res.statusCode).toEqual(404);
    });
});

describe('Database API Security Checks', () => {
    it('GET /history should return 401 Unauthorized without x-user-id header', async () => {
        const res = await request(app).get('/history');
        expect(res.statusCode).toEqual(401);
    });

    it('POST /history should return 400 Bad Request if track data is missing', async () => {
        const res = await request(app)
            .post('/history')
            .set('x-user-id', '1') 
            .send({}); 
        expect(res.statusCode).toEqual(400);
    });
});

describe('Tauri Sidecar Integration', () => {
    it('Should establish connection to the Node sidecar', async () => {
        const res = await request(app).get('/test');
        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('Server is working!');
    });

    it('Should reject database writes without auth', async () => {
        const res = await request(app).post('/history').send({ trackId: "123" });
        expect(res.statusCode).toEqual(400); 
    });
});