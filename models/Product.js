const mongoose = require('mongoose');

const supplierInfoSchema = new mongoose.Schema({
  supplierName: { type: String, default: '' },
  supplierCode: { type: String, default: '' },
  leadTimeDays: { type: Number, default: 0, min: 0 },
  purchasePrice: { type: Number, default: 0, min: 0 },
}, { _id: false });

const batchSchema = new mongoose.Schema({
  batchNo: { type: String, default: '' },
  qty: { type: Number, default: 0, min: 0 },
  expiryDate: { type: Date },
  purchasePrice: { type: Number, default: 0, min: 0 },
  mrp: { type: Number, default: 0, min: 0 },
  receivedAt: { type: Date, default: Date.now },
}, { _id: false });

const stockMovementSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['IN', 'OUT', 'ADJUST', 'DAMAGED', 'RETURN'],
    required: true,
  },
  qty: { type: Number, required: true },
  reason: { type: String, default: '' },
  ref: { type: String, default: '' },
  batchNo: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const variantSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  mrp: { type: Number, default: 0, min: 0 },
  stock: { type: Number, default: null, min: 0 },
  isActive: { type: Boolean, default: true },
}, { _id: true });

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  nameTa: {
    type: String,
    default: '',
    trim: true
  },
  brand: {
    type: String,
    default: '',
    trim: true
  },
  sku: {
    type: String,
    trim: true
  },
  barcode: {
    type: String,
    trim: true
  },
  description: {
    type: String,
    required: false,
    default: ''
  },
  shortDescription: {
    type: String,
    default: ''
  },
  usageInstructions: {
    type: String,
    default: ''
  },
  nutritionInfo: {
    type: String,
    default: ''
  },
  price: {
    type: Number,
    required: false,
    default: 0,
    min: 0
  },
  mrp: {
    type: Number,
    default: 0,
    min: 0
  },
  tax: {
    gstRate: { type: Number, default: 0, min: 0 },
    hsn: { type: String, default: '' },
    inclusive: { type: Boolean, default: true },
  },
  pricing: {
    promoPrice: { type: Number, default: null },
    promoStart: { type: Date, default: null },
    promoEnd: { type: Date, default: null },
    memberDiscountPct: { type: Number, default: 0, min: 0 },
  },
  category: {
    type: String,
    required: false,
    default: 'general'
  },
  subcategory: {
    type: String,
    default: '',
    trim: true
  },
  image: {
    type: String,
    default: ''
  },
  images: [{
    type: String,
    default: ''
  }],
  stock: {
    type: Number,
    required: false,
    min: 0,
    default: 0
  },
  variants: {
    type: [variantSchema],
    default: [],
  },
  lowStockThreshold: {
    type: Number,
    default: 5,
    min: 0
  },
  reservedStock: {
    type: Number,
    default: 0,
    min: 0
  },
  incomingStock: {
    type: Number,
    default: 0,
    min: 0
  },
  damagedStock: {
    type: Number,
    default: 0,
    min: 0
  },
  unit: {
    type: String,
    required: false,
    default: 'piece'
  },
  packSize: {
    value: { type: Number, default: null },
    unit: { type: String, default: '' },
    label: { type: String, default: '' },
  },
  isWeightBased: {
    type: Boolean,
    default: false
  },
  expiryDate: {
    type: Date,
    default: null
  },
  batches: [batchSchema],
  supplier: supplierInfoSchema,
  stockMovements: [stockMovementSchema],
  isActive: {
    type: Boolean,
    default: true
  },
  tags: [{
    type: String,
    lowercase: true
  }],
  voiceTags: [{
    type: String,
    lowercase: true
  }]
}, {
  timestamps: true
});

// Index for search functionality
productSchema.index({ name: 'text', description: 'text', tags: 'text', brand: 'text', sku: 'text', barcode: 'text' });

productSchema.index(
  { sku: 1 },
  {
    unique: true,
    partialFilterExpression: { sku: { $type: 'string', $ne: '' } },
  }
);

productSchema.index(
  { barcode: 1 },
  {
    unique: true,
    partialFilterExpression: { barcode: { $type: 'string', $ne: '' } },
  }
);

module.exports = mongoose.model('Product', productSchema);
