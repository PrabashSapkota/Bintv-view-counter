const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const cluster = require('cluster');
const os = require('os');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

// Get the number of available CPU cores
const numCPUs = os.cpus().length;

// --- Main Application Logic ---
// This function contains the entire server setup.
// It will be run by each worker process.
const startApp = () => {
  const app = express();
  app.use(cors());

  const server = http.createServer(app);

  // --- Redis and Socket.IO Adapter Setup ---
  // Create Redis clients. The adapter requires a publisher and a subscriber client.
  const pubClient = createClient({ url: 'redis://localhost:6379' });
  const subClient = pubClient.duplicate();

  const io = socketIo(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    // The Redis adapter allows Socket.IO to broadcast events across multiple processes.
    adapter: createAdapter(pubClient, subClient)
  });
  
  // Connect both Redis clients to the server.
  Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
    console.log(`Worker ${process.pid} connected to Redis and started.`);
  }).catch(err => {
    console.error(`Worker ${process.pid} failed to connect to Redis`, err);
  });

  // Helper function to get all view counts from Redis and broadcast to the dashboard.
  // We no longer manage clientInfo in memory to keep the workers stateless.
  async function broadcastViewData() {
    try {
      // HGETALL gets all fields and values from a hash in a single command.
      const viewCounts = await pubClient.hGetAll('viewCounts');

      // Convert Redis string values back to numbers for the client.
      for (const id in viewCounts) {
        viewCounts[id] = parseInt(viewCounts[id], 10);
      }
      
      // Emit to the dedicated '/view-data' namespace.
      io.of('/view-data').emit('viewData', { viewCounts, clientInfo: {} }); // clientInfo is now empty
    } catch (error)
    {
      console.error('Error fetching data from Redis for broadcast:', error);
    }
  }

  // --- Express HTTP Routes ---
  // This endpoint now fetches all data directly from Redis.
  app.get('/view-data', async (req, res) => {
    try {
        const viewCounts = await pubClient.hGetAll('viewCounts');
        for (const id in viewCounts) {
            viewCounts[id] = parseInt(viewCounts[id], 10);
        }
        res.json({ viewCounts, clientInfo: {} });
    } catch (error) {
        res.status(500).send('Error fetching data from Redis');
    }
  });

  app.get('/raw', async (req, res) => {
    try {
      const response = await axios.get('http://vccvcvvcvccvv.x10.mx/path.json');
      res.json(response.data);
    } catch (error) {
      res.status(500).send('Error fetching data from external source');
    }
  });

  // --- Socket.IO Namespaces ---
  // Namespace for the real-time dashboard viewer.
  io.of('/view-data').on('connection', (socket) => {
    console.log(`Dashboard viewer connected on worker ${process.pid}`);
    // Immediately send the current state to the new viewer.
    broadcastViewData();
  });

  // Main namespace for client connections.
  io.on('connection', (socket) => {
    const { id } = socket.handshake.query;
    const referrer = socket.handshake.headers.referer || 'Unknown';

    if (!id) {
      console.warn(`Client on worker ${process.pid} connected without an ID. Disconnecting.`);
      return socket.disconnect();
    }

    console.log(`Client connected to stream ${id} on worker ${process.pid}`);

    // Atomically increment the view count for the given ID in the 'viewCounts' hash.
    pubClient.hIncrBy('viewCounts', id, 1).then((newCount) => {
        // The Redis adapter ensures this 'emit' goes to ALL clients across ALL workers.
        io.emit('updateViewCount', { id, viewCount: newCount });
        broadcastViewData(); // Update the dashboard with the new totals.
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected from stream ${id} on worker ${process.pid}`);
      
      // Atomically decrement the view count.
      pubClient.hIncrBy('viewCounts', id, -1).then(async (newCount) => {
        let finalCount = newCount;
        // If the count for a stream drops to zero, remove it from Redis to save memory.
        if (newCount <= 0) {
          await pubClient.hDel('viewCounts', id);
          finalCount = 0;
        }

        // Broadcast the final count to all clients.
        io.emit('updateViewCount', { id, viewCount: finalCount });
        broadcastViewData(); // Update the dashboard.
      });
    });
  });

  const PORT = process.env.PORT || 7778;
  // Each worker process listens on the same port.
  server.listen(PORT, () => console.log(`Worker ${process.pid} listening on port ${PORT}`));
};


// --- Cluster Management ---
// This block runs only in the primary process.
if (cluster.isPrimary) {
  console.log(`Primary process ${process.pid} is running`);
  console.log(`Forking server for ${numCPUs} CPU cores`);

  // Create a worker process for each CPU core.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // If a worker process dies, log it and create a new one to maintain performance.
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Forking a new one...`);
    cluster.fork();
  });
} else {
  // This block runs in every worker process.
  // If this is not the primary process, start the application.
  startApp();
}