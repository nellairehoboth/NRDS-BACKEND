const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
    default: null
  },
  variantLabel: {
    type: String,
    default: ''
  },
  name: String,
  price: Number,
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  subtotal: Number
});

const orderSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  orderNumber: {
    type: String,
    unique: true,
    required: true,
    default: function() {
      return 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5).toUpperCase();
    }
  },
  items: [orderItemSchema],
  totalAmount: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: [
      'CREATED',
      'PAYMENT_PENDING',
      'PAID',
      'ADMIN_CONFIRMED',
      'SHIPPED',
      'DELIVERED',
      'CANCELLED',
      'pending',
      'confirmed',
      'processing',
      'shipped',
      'delivered',
      'cancelled'
    ],
    default: 'CREATED'
  },
  paymentMethod: {
    type: String,
    enum: ['cod', 'razorpay', 'dummy'],
    required: true
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded'],
    default: 'pending'
  },
  paymentId: String,
  paymentGatewayOrderId: String,
  paymentSignature: String,
  shippingAddress: {
    name: String,
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String,
    phone: String
  },
  deliveryDate: Date,
  notes: String
}, {
  timestamps: true
});

// Soft-delete flag to let users clear their order history without removing records
orderSchema.add({
  hiddenForUser: { type: Boolean, default: false }
});

// Note: orderNumber default is defined on the schema field to ensure it exists before validation

module.exports = mongoose.model('Order', orderSchema);
