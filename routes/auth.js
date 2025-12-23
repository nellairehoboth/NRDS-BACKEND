const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const router = express.Router();

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Google OAuth login
router.get('/google', (req, res) => {
  // Check if Google OAuth is properly configured
  if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'your_google_client_id_here') {
    return res.redirect(`${process.env.CLIENT_URL}/login?error=google_oauth_not_configured`);
  }

  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:5000/api/auth/google/callback`;
  const googleAuthURL = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=openid%20profile%20email&` +
    `response_type=code&` +
    `access_type=offline&` +
    `prompt=consent`;
  
  res.redirect(googleAuthURL);
});

// Google OAuth callback
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.redirect(`${process.env.CLIENT_URL}/login?error=no_code`);
    }

    // Exchange code for access token (Google requires x-www-form-urlencoded)
    const tokenBody = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      code: String(code || ''),
      grant_type: 'authorization_code',
      redirect_uri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:5000/api/auth/google/callback`,
    }).toString();

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenBody,
    });

    const tokenText = await tokenResponse.text();
    let tokenData;
    try { tokenData = JSON.parse(tokenText); } catch (e) { tokenData = { raw: tokenText }; }

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('Google token exchange failed:', {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        body: tokenData,
        hasClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
        hasSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CLIENT_SECRET !== 'GOCSPX-temp_secret_replace_with_real_one'),
        redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:5000/api/auth/google/callback`,
      });
      const msg = encodeURIComponent(tokenData.error_description || tokenData.error || 'token_failed');
      return res.redirect(`${process.env.CLIENT_URL}/login?error=${msg}`);
    }

    // Get user info from Google
    const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      const body = await userResponse.text();
      console.error('Failed to fetch Google userinfo:', userResponse.status, userResponse.statusText, body);
      return res.redirect(`${process.env.CLIENT_URL}/login?error=userinfo_failed`);
    }

    const googleUser = await userResponse.json();

    // Find or create user in database
    let user = await User.findOne({ 
      $or: [
        { googleId: googleUser.id },
        { email: googleUser.email }
      ]
    });

    if (!user) {
      // Create fresh user with valid enum role
      user = new User({
        googleId: googleUser.id,
        email: googleUser.email,
        name: googleUser.name,
        avatar: googleUser.picture,
        role: 'customer'
      });
      await user.save();
    } else {
      // Bring existing user into a valid state without saving invalid values first
      const update = {};
      if (!user.googleId) {
        update.googleId = googleUser.id;
      }
      if (!['customer', 'admin'].includes(user.role)) {
        update.role = 'customer';
      }
      if (Object.keys(update).length) {
        await User.updateOne({ _id: user._id }, { $set: update });
        Object.assign(user, update);
      }
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Redirect to frontend with token
    res.redirect(`${process.env.CLIENT_URL}/auth/success?token=${token}`);
  } catch (error) {
    console.error('Google OAuth callback error:', error);
    res.redirect(`${process.env.CLIENT_URL}/login?error=oauth_failed`);
  }
});

// Regular login with email and password
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and password are required' 
      });
    }

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }

    // Check password
    if (!user.password) {
      return res.status(401).json({ 
        success: false, 
        message: 'Please use Google login for this account' 
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// User signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, phone, address } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Name, email, and password are required' 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        success: false, 
        message: 'Password must be at least 6 characters long' 
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'User with this email already exists' 
      });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create new user
    const user = new User({
      name,
      email,
      password: hashedPassword,
      phone: phone || '',
      address: address || {},
      avatar: 'https://via.placeholder.com/150'
    });

    await user.save();

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        role: user.role
      },
      message: 'Account created successfully'
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ success: false, message: 'Signup failed' });
  }
});

// Demo login (for testing without Google OAuth)
router.post('/demo-login', async (req, res) => {
  try {
    const { email, name, role = 'customer' } = req.body;
    
    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        email,
        name,
        role,
        avatar: 'https://via.placeholder.com/150'
      });
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Demo login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// Get current user
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-googleId');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Logout
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

// Admin demo login (for testing admin features)
router.post('/admin-demo-login', async (req, res) => {
  try {
    const email = 'admin@groceryvoice.com';
    const name = 'Admin User';
    const role = 'admin';
    
    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        email,
        name,
        role,
        avatar: 'https://via.placeholder.com/150'
      });
      await user.save();
    } else {
      // Update role to admin if user exists
      user.role = 'admin';
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (error) {
    console.error('Admin demo login error:', error);
    res.status(500).json({ success: false, message: 'Admin login failed' });
  }
});

// Debug endpoint to verify Google OAuth server configuration (no secrets exposed)
router.get('/google/debug', (req, res) => {
  try {
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/google/callback';
    res.json({
      success: true,
      checks: {
        hasClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
        hasSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CLIENT_SECRET !== 'GOCSPX-temp_secret_replace_with_real_one'),
        clientIdLooksValid: /\.apps\.googleusercontent\.com$/.test(String(process.env.GOOGLE_CLIENT_ID || '')),
        redirectUri,
        clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Debug check failed' });
  }
});

module.exports = { router, authenticateToken };
