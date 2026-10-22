// src/services/AuthService.js
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { getUserByEmail, checkPrivilegesForRole } = require("../models/userModels");

const loginUser = async (email, password) => {
  const user = await getUserByEmail(email);
  if (!user) throw new Error("User not found");

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new Error("Invalid credentials");

  const homeacc = await checkPrivilegesForRole(user.role_id);

  const accessToken = jwt.sign(
    { 
      user_id: user.id, 
      role_id: user.role_id, 
      	branch_id	: user.	branch_id	,
    }, 
    process.env.ACCESS_TOKEN_SECRET, 
    { expiresIn: "15m" }
  );
  
  const refreshToken = jwt.sign(
    { 
      user_id: user.id, 
      role_id: user.role_id, 
      		branch_id		: user.	branch_id	,
    }, 
    process.env.REFRESH_TOKEN_SECRET, 
    { expiresIn: "7d" }
  );

  return { 
    user: {
      	branch_id	: user.	branch_id	,
      user_id: user.id,
      role_id: user.role_id,
      hacc: homeacc
    },
    accessToken,
    refreshToken
  };
};

//  Make sure to export correctly
module.exports = { loginUser };