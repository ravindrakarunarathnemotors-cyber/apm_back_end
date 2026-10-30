const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const cookieSession = require('cookie-session'); // Moved up to group imports

const authRoutes = require("./routes/authRoutes");
const clientStaffRoutes = require("./routes/clientStaffRoutes");
const brandingSettings = require("./routes/brandingSettings");
const clientManagement = require("./routes/clientManagement");
const adminSettings = require("./routes/adminSettings");
const uploadRoutes = require("./routes/uploadRoutes");
const complaint= require("./routes/complaint");
const hrm= require("./routes/hrm");
const team= require("./routes/team");
const evidence= require("./routes/evidence");
const bay= require("./routes/bay");
const damagereport= require("./routes/damagereport");
const inspection= require("./routes/inspection");
const spare= require("./routes/spare");
const Inventory= require("./routes/Inventory");
const inventoryfull= require("./routes/inventoryfull");
const customer_approval= require("./routes/customer_approval");
const internal_inspection= require("./routes/internal_inspection");
const job_activation= require("./routes/job_activation");


require('dotenv').config();

const app = express();

// ==========================================
// 1. PROXY TRUST (CRITICAL FOR CLOUDFLARE)
// ==========================================
// This tells Express it is behind a reverse proxy (Cloudflare).
// Without this, secure cookies will NEVER be set or read over HTTPS!
app.set('trust proxy', 1);

// ==========================================
// 2. CORS INITIALIZATION
// ==========================================
const allowedOrigins = [
    process.env.BILLING_SEND_INVOICE_URL,
    process.env.FRONTEND_URL,
    "http://localhost:6002"
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.options('*', cors());

// ==========================================
// 3. CORE PARSERS (MUST RUN BEFORE COOKIE SESSION)
// ==========================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); 

// ==========================================
// 4. COOKIE SESSION MIDDLEWARE
// ==========================================
app.use(cookieSession({
  name: 'billing_session',
  keys: [process.env.COOKIE_SECRET || 'fallback-cookie-secret-key'],
  maxAge: 24 * 60 * 60 * 1000, // 24 Hours
  
  // Shared domain across your entire setup
  domain: '.sparkglobalsolutions.net', 
  
  secure: true,    // Works now because trust proxy is enabled above
  httpOnly: true, 
  sameSite: 'none' // Necessary for cross-subdomain API fetches
}));

// ==========================================
// 5. SECURITY & LOGGING
// ==========================================
app.use(helmet());
app.use(morgan("dev"));

// ==========================================
// 6. REQUEST DEBUG LOGGING
// ==========================================
app.use((req, res, next) => {
  console.log('=== REQUEST DEBUG ===');
  console.log('URL:', req.method, req.url);
  // cookie-session values populate inside req.session, not standard req.cookies!
  console.log('Session Payload:', req.session); 
  console.log('Raw Headers Cookie:', req.headers.cookie);
  next();
});

// ==========================================
// 7. ROUTE REGISTRATIONS
// ==========================================
app.use("/auth", authRoutes);
app.use("/api", clientStaffRoutes);
app.use("/branding", brandingSettings);
app.use("/clients", clientManagement);
app.use("/settings", adminSettings);
app.use("/file", uploadRoutes); 
app.use("/complaint", complaint); 
app.use("/hrm", hrm); 
app.use("/team", team); 
app.use("/evidence", evidence); 
app.use("/bay", bay); 
app.use("/damagereport", damagereport); 
app.use("/inspection", inspection); 
app.use("/spare", spare); 
app.use("/Inventory", Inventory); 
app.use("/inventoryfull", inventoryfull); 
app.use("/customer_approval", customer_approval); 
app.use("/internal_inspection", internal_inspection); 
app.use("/job_activation", job_activation); 




module.exports = app;