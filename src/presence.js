// Presence is derived from live sockets rather than stored state, so it
// can never go stale. With the Redis adapter, fetchSockets() returns
// sockets from EVERY instance, which is what makes the online-users list
// correct across the whole cluster.
export function createPresence(io) {
  async function usersIn(room) {
    const sockets = await io.in(room).fetchSockets();
    const names = new Set();
    for (const s of sockets) {
      if (s.data?.username) names.add(s.data.username);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  async function broadcast(room) {
    try {
      const users = await usersIn(room);
      io.to(room).emit('presence', { room, users });
    } catch (err) {
      // fetchSockets can time out if a peer instance is mid-shutdown;
      // a missed presence refresh is harmless, so don't propagate.
      console.warn(`[presence] refresh for "${room}" failed: ${err.message}`);
    }
  }

  return { usersIn, broadcast };
}
