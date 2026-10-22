const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const pool = require("../config/db");
const { formatPhoneNumber, insertAdminLog, insertAdminlogs } = require("../models/userModels");
const { sendsmstemp } = require("../models/smstempmodels")
require("dotenv").config();


const router = express.Router();




module.exports = router;
