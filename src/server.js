const http = require("http");
const { Server } = require("socket.io");
const { Client } = require('ssh2');
const CryptoJS = require('crypto-js');
const app = require("./app");
const pool = require("./config/db");

const PORT = process.env.PORT || 5008;

// 1. Create HTTP Server
const server = http.createServer(app);

// 2. Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:6002", 
    methods: ["GET", "POST"],
    credentials: true
  }
});

// 3. Store active admin connections
global.adminSockets = new Map(); 
global.sshConnections = new Map(); // Store SSH connections

io.on("connection", (socket) => {
  // Use a fallback to check both query and headers
  const userId = socket.handshake.query.userId;

  if (userId && userId !== "undefined") {
    global.adminSockets.set(userId.toString(), socket.id);
    console.log(` Socket Registered: User ${userId} is now online.`);
    console.log("Active Users Map:", Array.from(global.adminSockets.keys()));
  }

  // ==================== SSH TERMINAL HANDLERS ====================
  
  let sshClient = null;
  let sshStream = null;

  socket.on("ssh-connect", async (data) => {
    const { serverId } = data;
    
    try {
      console.log(`🔌 SSH Connect request for server ${serverId}`);
      
      // Get server details from database
      const result = await pool.query(
        `SELECT 
          id, 
          node_name, 
          ip_address, 
          port, 
          username, 
          password, 
          server_type, 
          status 
        FROM server_nodes 
        WHERE id = $1`,
        [serverId]
      );
      
      const server = result.rows[0];
      
      if (!server) {
        socket.emit('ssh-error', 'Server not found');
        return;
      }

      if (server.status !== 'active') {
        socket.emit('ssh-error', 'Server is not active');
        return;
      }

      // Decrypt password
      const ENCRYPTION_KEY = process.env.SERVER_PASSWORD_KEY;
      if (!ENCRYPTION_KEY) {
        socket.emit('ssh-error', 'Encryption key not configured');
        return;
      }

      const decryptedPassword = CryptoJS.AES.decrypt(
        server.password,
        ENCRYPTION_KEY
      ).toString(CryptoJS.enc.Utf8);

      if (!decryptedPassword) {
        socket.emit('ssh-error', 'Invalid password');
        return;
      }

      // Create SSH connection
      sshClient = new Client();
      
      sshClient.on('ready', () => {
        console.log(` SSH connection ready for ${server.node_name}`);
        socket.emit('ssh-connected', `Connected to ${server.node_name}\r\n`);
        
        // Create shell session
        sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            console.error('Shell error:', err);
            socket.emit('ssh-error', 'Failed to create shell: ' + err.message);
            return;
          }
          
          sshStream = stream;
          
          // Store connection for cleanup
          global.sshConnections.set(socket.id, { sshClient, sshStream });
          
          // Send data to client
          stream.on('data', (data) => {
            socket.emit('ssh-data', data.toString('utf-8'));
          });
          
          stream.on('close', () => {
            console.log('Shell session closed');
            socket.emit('ssh-disconnected', '\r\nSession closed\r\n');
            if (sshClient) {
              sshClient.end();
            }
          });
          
          stream.on('error', (err) => {
            console.error('Stream error:', err);
            socket.emit('ssh-error', 'Stream error: ' + err.message);
          });
        });
      });

      sshClient.on('error', (err) => {
        console.error('SSH error:', err);
        socket.emit('ssh-error', 'SSH connection error: ' + err.message);
      });

      sshClient.on('close', () => {
        console.log('SSH connection closed');
        socket.emit('ssh-disconnected', '\r\nConnection closed\r\n');
        sshClient = null;
        sshStream = null;
        global.sshConnections.delete(socket.id);
      });

      // Connect to server
      sshClient.connect({
        host: server.ip_address,
        port: parseInt(server.port) || 22,
        username: server.username,
        password: decryptedPassword,
        readyTimeout: 10000,
        keepaliveInterval: 30000,
        keepaliveCountMax: 3
      });

    } catch (error) {
      console.error('Connection error:', error);
      socket.emit('ssh-error', 'Connection error: ' + error.message);
    }
  });

  // Handle commands from client
// In your server.js, update the ssh-command handler
// In server.js - Update ssh-command handler
socket.on('ssh-command', (command) => {
  console.log('Received command:', command);
  if (sshStream && sshStream.writable) {
    sshStream.write(command);
  } else {
    socket.emit('ssh-error', 'No active shell session');
  }
});
  // Handle resize
  socket.on('ssh-resize', (data) => {
    if (sshStream) {
      try {
        sshStream.setWindow(data.rows, data.cols);
      } catch (error) {
        console.error('Resize error:', error);
      }
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    // Find and delete the userId associated with this socketId
    for (let [uid, sid] of global.adminSockets.entries()) {
      if (sid === socket.id) {
        global.adminSockets.delete(uid);
        console.log(`❌ User ${uid} disconnected`);
        break;
      }
    }
    
    // Cleanup SSH connections
    const sshConnection = global.sshConnections.get(socket.id);
    if (sshConnection) {
      if (sshConnection.sshStream) {
        try {
          sshConnection.sshStream.end();
        } catch (e) {}
      }
      if (sshConnection.sshClient) {
        try {
          sshConnection.sshClient.end();
        } catch (e) {}
      }
      global.sshConnections.delete(socket.id);
      console.log('🧹 SSH connection cleaned up');
    }
  });
});

// 4. Make 'io' accessible in routes
app.set("socketio", io);

pool.connect()
  .then(() => {
    console.log("Connected to PostgreSQL");
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => console.error("Database connection error:", err));