// GET /api/sync-google
// Manually re-runs the Gmail + Drive pull using whatever token is already
// saved in Supabase. Useful for refreshing the dashboard without re-logging
// in to Google every time. Safe to call repeatedly (it's an upsert).
const { syncGoogleData } = require('./_googleSync');

module.exports = async (req, res) => {
  try {
    const result = await syncGoogleData();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
};
