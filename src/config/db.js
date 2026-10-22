require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Set time zone on each new client connection
pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'Asia/Colombo';");
});

module.exports = pool;