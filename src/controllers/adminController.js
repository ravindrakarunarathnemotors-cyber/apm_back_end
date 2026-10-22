const pool = require("../config/db");
const bcrypt = require('bcrypt');

const useDetails = async (req, res) => {
    const user = req.user
    const user_id = user.user_id

    try {
        const query = `SELECT first_name, last_name, mobile, email,profile_image	 FROM admin_user WHERE id = $1`;
        const { rows } = await pool.query(query, [user_id]);
        if (rows.length === 0) return res.status(400).json({ message: "User not found" })
        res.status(200).json({ message: "User details", result: rows[0] });
    } catch (error) {
        console.log("server error", error)
        res.status(500).json({ message: "Server error" });

    }

}


const updateUser = async (req, res) => {
    const user = req.user
    const user_id = user.user_id
    console.log(req.body)
    const { first_name, last_name, mobile, email } = req.body
    try {
        const query = `UPDATE admin_user SET first_name = $1, last_name = $2, mobile = $3, email = $4 WHERE id = $5 RETURNING *`;
        const { rowCount } = await pool.query(query, [first_name, last_name, mobile, email, user_id]);
        if (rowCount === 0) return res.status(400).json({ message: "User not found" })
        return res.status(200).json({ message: "User updated successfully" });
    } catch (error) {
        console.log("server error", error)
        res.status(500).json({ message: "Server error" });

    }
}
const changePassword = async (req, res) => {
  try {
    // Ensure authenticated user exists
    const user = req.user;
    if (!user || !user.user_id) {
      return res.status(401).json({ message: 'Unauthorized: user not found' });
    }

    const user_id = user.user_id;
    const { current_password, new_password } = req.body;

    const currentPassword = current_password;
    const newPassword = new_password;

    // Basic input validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Both current and new passwords are required' });
    }

    // Optional: prevent same password reuse
    if (currentPassword === newPassword) {
      return res.status(400).json({ message: 'New password cannot be the same as the current password' });
    }

    // Fetch user password from DB
    const query = 'SELECT password FROM admin_user WHERE id = $1';
    const { rows } = await pool.query(query, [user_id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const dbPassword = rows[0].password;

    // Compare old password
    const isMatch = await bcrypt.compare(currentPassword, dbPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    const updateQuery = 'UPDATE admin_user SET password = $1, updated_at = NOW() WHERE id = $2';
    await pool.query(updateQuery, [hashedPassword, user_id]);

    // Success
    return res.status(200).json({ message: 'Password updated successfully' });

  } catch (error) {
    console.error('Error updating password:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
};



module.exports = { useDetails, updateUser, changePassword }