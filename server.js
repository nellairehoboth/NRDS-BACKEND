require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');

const User = require('./models/User');

const app = express();

/* =======================
   Middleware
======================= */

app.use(cors({
  origin: [
    'http://localhost:3000',
    process.env.CLIENT_URL
  ],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =======================
   Routes
======================= */

const { router: authRoutes } = require('./routes/auth');
const productsRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const ordersRoutes = require('./routes/orders');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');
const mapsRoutes = require('./routes/maps');
const usersRoutes = require('./routes/users');

app.use('/api/auth', authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/maps', mapsRoutes);
app.use('/api/users', usersRoutes);

/* =======================
   Static Files
======================= */

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* =======================
   Root & Health
======================= */

app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Nellai Rehoboth Department Stores API',
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

/* =======================
   Database Connection
======================= */

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/NRDS';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  console.log('✅ MongoDB connected');

  /* =======================
     Admin Auto-Seed
  ======================= */

  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (adminEmail && adminPassword) {
      let admin = await User.findOne({ email: adminEmail });
      const hashedPassword = await bcrypt.hash(adminPassword, 10);

      if (!admin) {
        admin = new User({
          name: 'Admin User',
          email: adminEmail,
          password: hashedPassword,
          role: 'admin',
          avatar: 'https://ui-avatars.com/api/?name=Admin&background=random',
          credits: 10000
        });
        await admin.save();
        console.log('✅ Default admin created');
      } else {
        await User.updateOne(
          { _id: admin._id },
          { $set: { password: hashedPassword, role: 'admin', credits: 10000 } }
        );
        console.log('✅ Default admin ensured');
      }
    }
  } catch (err) {
    console.error('❌ Admin seeding error:', err.message);
  }

  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });

  server.timeout = 600000; // 10 minutes (bulk uploads)

})
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

/* =======================
   Global Error Handler
======================= */

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});
