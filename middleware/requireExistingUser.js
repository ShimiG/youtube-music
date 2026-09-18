// Confirms the user named by the session JWT still exists in the database.
// Must run AFTER requireAuth (relies on req.userId).
//
// requireAuth only verifies the token's signature, so a validly signed token
// for an account that has since been deleted (or that was created against a
// different copy of database.sqlite) is accepted everywhere. Most routes then
// simply return empty results, but the OAuth connect flows insert a row whose
// user_id has a FOREIGN KEY to users(id), and that insert fails only after the
// user has completed a full round-trip to Google or SoundCloud. Checking here
// fails fast, before the redirect, with an actionable message.
module.exports = async (req, res, next) => {
    try {
        const row = await req.app.locals.db.get(`SELECT id FROM users WHERE id = ?`, [req.userId]);
        if (!row) {
            return res.status(401).json({
                error: 'Your session refers to an account that no longer exists. Log out and log in again.',
                code: 'USER_NOT_FOUND'
            });
        }
        next();
    } catch (err) {
        next(err);
    }
};
