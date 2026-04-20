# Getting Started with Security Fixes

## Quick Start

### 1. Install Dependencies
```bash
npm install
cd client && npm install && cd ..
```

### 2. Setup Environment Variables
```bash
# Copy the template
cp .env.example .env

# Edit .env with your actual values
# Important: Update GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET with NEW credentials
# (Old credentials are publicly compromised)
```

### 3. Start the Application
```bash
# Development mode (runs backend + frontend)
npm run dev

# Or separately:
# Terminal 1: Backend
npm run server

# Terminal 2: Frontend
npm run client
```

### 4. Access the Application
- Frontend: http://localhost:5173
- Backend: http://localhost:3000
- API Documentation: See routes in server.js

---

## Important Changes

### 🔒 Authentication
- **Old**: Tokens in localStorage + custom headers
- **New**: HTTP-only cookies + JWT tokens (automatic)

### 🔑 Your First Login
1. Go to http://localhost:5173
2. Choose local auth or Google OAuth
3. For local: Use strong password (12+ chars, mixed case, number, special char)
4. Session automatically created (lasts 1 hour)

### 🛡️ API Calls
All API calls now require valid JWT in cookie:
```javascript
// Automatically sent with credentials: 'include'
fetch('http://localhost:3000/stream', {
    credentials: 'include'
});
```

---

## Configuration Guide

### Google OAuth (Required)
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create new OAuth 2.0 credentials
3. Add redirect URI: `http://localhost:3000/auth/google/callback`
4. Copy Client ID and Secret to .env

### Environment Variables

**Security:**
```env
JWT_SECRET=your-super-secret-key-min-32-chars
NODE_ENV=development
```

**CORS (Frontend Origins):**
```env
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

**Streaming:**
```env
MAX_CONCURRENT_STREAMS=10
PROCESS_TIMEOUT=60000  # milliseconds
```

**Database:**
```env
DB_PATH=./database.sqlite
```

---

## Testing Endpoints

### Test Local Authentication
```bash
# Register
curl -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "email": "test@example.com",
    "password": "SecurePassword123!"
  }'

# Login (saves cookie)
curl -X POST http://localhost:3000/api/login \
  -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "password": "SecurePassword123!"
  }'

# Access protected endpoint with cookie
curl -b cookies.txt http://localhost:3000/search?q=music
```

### Test Google OAuth
Visit: `http://localhost:3000/auth/google`

### Test Streaming (with Auth)
```bash
# With valid session/cookie
curl -b cookies.txt http://localhost:3000/stream?videoId=dQw4w9WgXcQ
```

---

## Troubleshooting

### "No access token provided" Error
- ✅ Clear browser cookies/cache
- ✅ Log out and log in again
- ✅ Check NODE_ENV is not production without HTTPS

### "Invalid CORS origin" Error
- ✅ Check CORS_ORIGINS in .env
- ✅ Frontend URL must match exactly (including port)
- ✅ Restart backend after changing .env

### "JWT expired" Error
- ✅ This is expected after 1 hour
- ✅ Implement token refresh (see SECURITY_FIXES.md)
- ✅ Log in again to get new token

### Rate Limiting - "Too many attempts" Error
- ✅ Wait 15 minutes for login limit reset
- ✅ Wait 1 hour for registration limit reset
- ✅ Different limits per IP address

### Process Timeout - "Stream processing timeout"
- ✅ Increase PROCESS_TIMEOUT in .env (if needed)
- ✅ Check internet connection
- ✅ YouTube might be blocking yt-dlp

---

## Development Tips

### Enable Verbose Logging
```bash
LOG_LEVEL=debug npm run dev
```

### Check Active Sessions
Sessions stored in express-session (in-memory for dev)

### Monitor Streams
Check active stream count in logs:
```
[YouTube] Stream completed { videoId, duration, code }
```

### Database
Located at: `./database.sqlite`
Use SQLite3 CLI to inspect:
```bash
sqlite3 database.sqlite
> SELECT * FROM users;
> .tables
```

---

## Security Checklist Before Production

- [ ] Generate new Google OAuth credentials
- [ ] Update all environment variables
- [ ] Set NODE_ENV=production
- [ ] Setup HTTPS with valid certificate
- [ ] Configure firewall rules
- [ ] Setup database backups
- [ ] Enable monitoring/logging
- [ ] Test authentication flow
- [ ] Test streaming with auth
- [ ] Test rate limiting
- [ ] Verify CORS restrictions
- [ ] Run security audit

---

## Next Steps

1. **Implement Token Refresh** (Optional but recommended)
   - See SECURITY_FIXES.md for implementation
   - Allows long sessions without re-login

2. **Setup Monitoring**
   - Monitor auth failures
   - Alert on rate limit abuse
   - Track streaming access

3. **Add 2FA** (Recommended)
   - Additional account protection
   - Email or TOTP based

4. **Perform Security Testing**
   - OWASP ZAP scan
   - Penetration testing
   - Load testing

---

## Useful Commands

```bash
# Development
npm run dev

# Build for production
npm run build:all

# Run tests
npm test

# Run with watch mode
npm run test:watch

# Database migration (if needed)
npm run migrate

# Clean cache
rm -rf cache/*.mp3 cache/*.m4a
rm -rf logs/*.log
```

---

## Contact & Support

For security issues:
- **Do NOT** open public issues
- Report privately to security team
- Include steps to reproduce
- Include affected versions

---

## License
See LICENSE file

