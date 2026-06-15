// In-memory store for tracking pairing/QR socket connection status
export const pairingSessions = new Map();

// Cleanup function to avoid memory and disk leaks
export function cleanOldSessions() {
  const now = Date.now();
  for (const [id, session] of pairingSessions.entries()) {
    // Session is older than 5 minutes
    if (now - session._ts > 5 * 60 * 1000) {
      console.log(`[CLEANUP] Cleaning up expired session ${id}`);
      try {
        if (session.sock) {
          session.sock.ws?.close();
          session.sock.end();
        }
      } catch (e) {
        console.error(`[CLEANUP] Error closing socket for ${id}:`, e);
      }
      pairingSessions.delete(id);
    }
  }
}

// Run cleanup every 1 minute
setInterval(cleanOldSessions, 60 * 1000);
