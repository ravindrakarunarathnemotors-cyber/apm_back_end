const { loginUser } = require("../services/AuthService");

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Get user data and tokens from service
    const { user, accessToken, refreshToken } = await loginUser(email, password);
    
    // Set access token cookie
    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1 * 60 * 1000, // 15 minutes
    });
    
    // Set refresh token cookie
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    
    // Send user data (NO tokens in response body)
    res.json({
      success: true,
      user_id: user.user_id,
      role_id: user.role_id,
      client_id: user.client_id,
      branch_id: user.branch_id,
      hacc: user.hacc
    });
    
  } catch (error) {
    res.status(401).json({ message: error.message });
  }
};

module.exports = { login };