const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const { authenticateToken } = require('./auth');
const fs = require('fs');
const axios = require('axios');
const router = express.Router();


// Email notifications flag
const EMAIL_ENABLED = String(process.env.ENABLE_EMAIL_NOTIFICATIONS || '').toLowerCase() === 'true';

// Helper: send order cancellation email (best-effort)
async function sendOrderCancelEmailNotification(order, userId) {
  try {
    if (!EMAIL_ENABLED) return;
    const { BREVO_API_KEY, EMAIL_FROM } = process.env;
    if (!BREVO_API_KEY || !EMAIL_FROM) return;

    // Determine recipient
    let toEmail;
    if (userId) {
      const u = await User.findById(userId).select('email');
      toEmail = u?.email;
    }
    if (!toEmail && process.env.EMAIL_TEST_TO) toEmail = process.env.EMAIL_TEST_TO;
    if (!toEmail) return;

    let SibApiV3Sdk;
    try { SibApiV3Sdk = require('@getbrevo/brevo'); } catch (_) { return; }

    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    apiInstance.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

    // Parse EMAIL_FROM
    let senderName = "GroceryVoice";
    let senderEmail = EMAIL_FROM;
    if (EMAIL_FROM.includes('<')) {
      const match = EMAIL_FROM.match(/"?([^"<]+)"?\s*<([^>]+)>/);
      if (match) {
        senderName = match[1].trim();
        senderEmail = match[2].trim();
      }
    }

    const subject = `Order Cancelled: ${order.orderNumber}`;
    const text = `Hello,\n\nYour order ${order.orderNumber} has been cancelled by admin.\n\nGroceryVoice`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#222">
        <h2>Order Cancelled</h2>
        <p>Your order has been cancelled.</p>
        <p><strong>Order No:</strong> ${order.orderNumber}</p>
        <p style="color:#666">GroceryVoice</p>
      </div>`;

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = html;
    sendSmtpEmail.textContent = text;
    sendSmtpEmail.sender = { name: senderName, email: senderEmail };
    sendSmtpEmail.to = [{ email: toEmail }];

    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    if (EMAIL_ENABLED) {
      try { console.log('Email cancel notify success:', data.messageId, 'to', toEmail); } catch (_) { }
    }
  } catch (err) {
    if (EMAIL_ENABLED) console.error('Email cancel notify error (non-fatal):', err.response?.body || err.message || err);
  }
}

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required'
    });
  }
  next();
};

// All admin routes require authentication and admin role
router.use(authenticateToken);
router.use(requireAdmin);

// Multer for file upload
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const xlsx = require('xlsx');

router.post('/products/bulk-upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Read as array of arrays (header: 1) since there are no headers
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    const allBulkOps = rows.map((row) => {
      // Skip empty rows
      if (!row || row.length === 0) return null;

      // Column Mapping (0-based index) - as defined previously
      const rawName = row[2];
      if (!rawName) return null;

      const rawStatus = row[1];
      const isActive = String(rawStatus || '').toLowerCase().includes('inactive') ? false : true;

      const barcode = row[0] ? String(row[0]).trim() : ''; // Column A (Index 0)

      const name = String(rawName).trim();
      const category = row[4] ? String(row[4]).trim() : 'pantry';
      const brand = row[7] ? String(row[7]).trim() : '';

      const gstRate = row[14] ? parseFloat(row[14]) : 0;
      const mrp = row[17] ? parseFloat(row[17]) : 0;
      const price = row[20] ? parseFloat(row[20]) : 0;

      return {
        updateOne: {
          filter: { name: name },
          update: {
            $set: {
              name,
              barcode, // Save the barcode
              category,
              brand,
              'tax.gstRate': isNaN(gstRate) ? 0 : gstRate,
              mrp: isNaN(mrp) ? 0 : mrp,
              price: isNaN(price) ? 0 : price,
              isActive,
              stock: 100
            }
          },
          upsert: true
        }
      };
    }).filter(Boolean);

    if (allBulkOps.length > 0) {
      // batch processing
      const BATCH_SIZE = 500;
      let totalMatched = 0;
      let totalModified = 0;
      let totalUpserted = 0;

      for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
        const batch = allBulkOps.slice(i, i + BATCH_SIZE);
        const result = await Product.bulkWrite(batch);
        totalMatched += result.matchedCount;
        totalModified += result.modifiedCount;
        totalUpserted += result.upsertedCount;
      }

      res.json({
        success: true,
        message: `Processed ${allBulkOps.length} products successfully.`,
        stats: {
          matched: totalMatched,
          modified: totalModified,
          upserted: totalUpserted
        }
      });
    } else {
      res.json({ success: false, message: 'No valid product data found in file.' });
    }

  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({ success: false, message: 'Failed to process file', error: error.message });
  }
});


router.delete('/products/delete-all', async (req, res) => {
  try {
    console.log('[Admin] Received request to delete ALL products');
    const result = await Product.deleteMany({});
    console.log(`[Admin] Successfully deleted ${result.deletedCount} products`);
    res.json({ success: true, message: 'All products deleted successfully', count: result.deletedCount });
  } catch (error) {
    console.error('Admin Delete All error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete all products', error: error.message });
  }
});




// Get all products (admin view) with pagination
router.get('/products', async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '', category = 'all', stock = 'all' } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    let query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { barcode: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }
    if (category !== 'all') {
      query.category = category;
    }
    if (stock === 'low') {
      query.stock = { $lte: 5 };
    } else if (stock === 'out') {
      query.stock = { $lte: 0 };
    }

    const totalProducts = await Product.countDocuments(query);
    const products = await Product.find(query)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    res.json({
      success: true,
      products,
      totalPages: Math.ceil(totalProducts / limitNum),
      currentPage: pageNum,
      totalProducts
    });
  } catch (error) {
    console.error('Admin get products error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch products' });
  }
});

// Create new product
router.post('/products', async (req, res) => {
  try {
    const {
      name,
      description,
      shortDescription,
      usageInstructions,
      nutritionInfo,
      brand,
      sku,
      barcode,
      price,
      mrp,
      tax,
      category,
      subcategory,
      stock,
      unit,
      variants,
      packSize,
      expiryDate,
      supplier,
      image,
      images,
      tags,
      voiceTags
    } = req.body;

    if (!name || !description || !category || !unit) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided'
      });
    }

    const normalizeTags = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(t => String(t).trim().toLowerCase()).filter(Boolean);
      return String(v)
        .split(',')
        .map(tag => tag.trim().toLowerCase())
        .filter(Boolean);
    };

    const safePackSize = (() => {
      if (!packSize) return undefined;
      const value = packSize?.value !== undefined && packSize?.value !== null ? Number(packSize.value) : null;
      const unit = packSize?.unit !== undefined ? String(packSize.unit) : '';
      const label = packSize?.label !== undefined ? String(packSize.label) : '';
      return { value: Number.isFinite(value) ? value : null, unit, label };
    })();

    const safeTax = (() => {
      if (!tax) return undefined;
      const gstRate = tax?.gstRate !== undefined && tax?.gstRate !== null ? Number(tax.gstRate) : 0;
      const hsn = tax?.hsn !== undefined ? String(tax.hsn) : '';
      const inclusive = tax?.inclusive !== undefined ? Boolean(tax.inclusive) : true;
      return { gstRate: Number.isFinite(gstRate) ? gstRate : 0, hsn, inclusive };
    })();

    const safeSku = (() => {
      if (sku === undefined || sku === null) return undefined;
      const v = String(sku).trim();
      return v ? v : undefined;
    })();

    const safeBarcode = (() => {
      if (barcode === undefined || barcode === null) return undefined;
      const v = String(barcode).trim();
      return v ? v : undefined;
    })();

    const safeVariants = (() => {
      if (!Array.isArray(variants)) return undefined;
      return variants
        .map((v) => {
          const label = v?.label !== undefined && v?.label !== null ? String(v.label).trim() : '';
          const price = v?.price !== undefined && v?.price !== null && v?.price !== '' ? Number(v.price) : NaN;
          const mrp = v?.mrp !== undefined && v?.mrp !== null && v?.mrp !== '' ? Number(v.mrp) : 0;
          const stock = v?.stock === '' || v?.stock === null || v?.stock === undefined ? null : Number(v.stock);
          const isActive = v?.isActive !== undefined ? Boolean(v.isActive) : true;
          if (!label || !Number.isFinite(price) || price < 0) return null;
          return {
            label,
            price,
            mrp: Number.isFinite(mrp) && mrp >= 0 ? mrp : 0,
            stock: stock === null ? null : (Number.isFinite(stock) && stock >= 0 ? stock : null),
            isActive,
          };
        })
        .filter(Boolean);
    })();

    const variantsProvided = Array.isArray(variants) && variants.length > 0;
    if (variantsProvided && (!safeVariants || safeVariants.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'Variants provided but invalid. Each variant must have a label and a valid price.'
      });
    }

    const derivedBase = (() => {
      const hasVariants = Array.isArray(safeVariants) && safeVariants.length > 0;
      if (!hasVariants) return null;

      const prices = safeVariants.map(v => Number(v.price)).filter(n => Number.isFinite(n));
      const mrps = safeVariants.map(v => Number(v.mrp)).filter(n => Number.isFinite(n));
      const stocks = safeVariants
        .map(v => v.stock)
        .filter(v => v !== null && v !== undefined)
        .map(v => Number(v))
        .filter(n => Number.isFinite(n));

      return {
        price: prices.length ? Math.min(...prices) : 0,
        mrp: mrps.length ? Math.max(...mrps) : 0,
        stock: stocks.length ? stocks.reduce((a, b) => a + b, 0) : 0,
      };
    })();

    if ((!safeVariants || safeVariants.length === 0) && (price === undefined || price === null || price === '' || stock === undefined || stock === null || stock === '')) {
      return res.status(400).json({
        success: false,
        message: 'Price and stock are required when no variants are provided'
      });
    }

    const product = new Product({
      name,
      description,
      shortDescription: shortDescription || '',
      usageInstructions: usageInstructions || '',
      nutritionInfo: nutritionInfo || '',
      brand: brand || '',
      sku: safeSku,
      barcode: safeBarcode,
      price: derivedBase ? derivedBase.price : parseFloat(price),
      mrp: derivedBase ? derivedBase.mrp : (mrp !== undefined && mrp !== null && mrp !== '' ? parseFloat(mrp) : 0),
      tax: safeTax,
      category,
      subcategory: subcategory || '',
      stock: derivedBase ? derivedBase.stock : parseInt(stock),
      unit,
      image: image || '',
      images: Array.isArray(images) ? images : [],
      variants: safeVariants,
      packSize: safePackSize,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      supplier: supplier || undefined,
      tags: normalizeTags(tags),
      voiceTags: normalizeTags(voiceTags)
    });

    await product.save();
    res.status(201).json({
      success: true,
      product,
      message: 'Product created successfully'
    });
  } catch (error) {
    console.error('Admin create product error:', error);

    if (error?.code === 11000) {
      const field = Object.keys(error.keyPattern || error.keyValue || {})[0] || 'field';
      return res.status(409).json({
        success: false,
        message: `${field} already exists. Please use a unique value.`
      });
    }

    res.status(500).json({ success: false, message: 'Failed to create product' });
  }
});

// Update product
router.put('/products/:id', async (req, res) => {
  try {
    const {
      name,
      description,
      shortDescription,
      usageInstructions,
      nutritionInfo,
      brand,
      sku,
      barcode,
      price,
      mrp,
      tax,
      category,
      subcategory,
      stock,
      unit,
      variants,
      packSize,
      expiryDate,
      supplier,
      image,
      images,
      tags,
      voiceTags,
      isActive
    } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (description) updateData.description = description;
    if (shortDescription !== undefined) updateData.shortDescription = shortDescription;
    if (usageInstructions !== undefined) updateData.usageInstructions = usageInstructions;
    if (nutritionInfo !== undefined) updateData.nutritionInfo = nutritionInfo;
    if (brand !== undefined) updateData.brand = brand;
    if (sku !== undefined) {
      const v = sku === null ? '' : String(sku).trim();
      if (!v) updateData.$unset = { ...(updateData.$unset || {}), sku: 1 };
      else updateData.sku = v;
    }
    if (barcode !== undefined) {
      const v = barcode === null ? '' : String(barcode).trim();
      if (!v) updateData.$unset = { ...(updateData.$unset || {}), barcode: 1 };
      else updateData.barcode = v;
    }
    if (price) updateData.price = parseFloat(price);
    if (mrp !== undefined) updateData.mrp = mrp === '' || mrp === null ? 0 : parseFloat(mrp);
    if (tax !== undefined) updateData.tax = tax;
    if (category) updateData.category = category;
    if (subcategory !== undefined) updateData.subcategory = subcategory;
    if (stock !== undefined) updateData.stock = parseInt(stock);
    if (unit) updateData.unit = unit;
    if (image !== undefined) updateData.image = image;
    if (images !== undefined) updateData.images = Array.isArray(images) ? images : [];
    if (variants !== undefined) {
      if (!Array.isArray(variants)) updateData.variants = [];
      else {
        updateData.variants = variants
          .map((v) => {
            const label = v?.label !== undefined && v?.label !== null ? String(v.label).trim() : '';
            const price = v?.price !== undefined && v?.price !== null && v?.price !== '' ? Number(v.price) : NaN;
            const mrpVal = v?.mrp !== undefined && v?.mrp !== null && v?.mrp !== '' ? Number(v.mrp) : 0;
            const stockVal = v?.stock === '' || v?.stock === null || v?.stock === undefined ? null : Number(v.stock);
            const isActiveVal = v?.isActive !== undefined ? Boolean(v.isActive) : true;
            if (!label || !Number.isFinite(price) || price < 0) return null;
            return {
              label,
              price,
              mrp: Number.isFinite(mrpVal) && mrpVal >= 0 ? mrpVal : 0,
              stock: stockVal === null ? null : (Number.isFinite(stockVal) && stockVal >= 0 ? stockVal : null),
              isActive: isActiveVal,
            };
          })
          .filter(Boolean);
      }
    }
    if (packSize !== undefined) updateData.packSize = packSize;
    if (expiryDate !== undefined) updateData.expiryDate = expiryDate ? new Date(expiryDate) : null;
    if (supplier !== undefined) updateData.supplier = supplier;
    if (tags !== undefined) {
      if (Array.isArray(tags)) updateData.tags = tags.map(t => String(t).trim().toLowerCase()).filter(Boolean);
      else updateData.tags = String(tags).split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
    }
    if (voiceTags !== undefined) {
      if (Array.isArray(voiceTags)) updateData.voiceTags = voiceTags.map(t => String(t).trim().toLowerCase()).filter(Boolean);
      else updateData.voiceTags = String(voiceTags).split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
    }
    if (isActive !== undefined) updateData.isActive = isActive;

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.json({
      success: true,
      product,
      message: 'Product updated successfully'
    });
  } catch (error) {
    console.error('Admin update product error:', error);

    if (error?.code === 11000) {
      const field = Object.keys(error.keyPattern || error.keyValue || {})[0] || 'field';
      return res.status(409).json({
        success: false,
        message: `${field} already exists. Please use a unique value.`
      });
    }

    res.status(500).json({ success: false, message: 'Failed to update product' });
  }
});

// Delete product
router.delete('/products/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Admin delete product error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete product' });
  }
});

// Bulk Sync products (from offline software)
router.post('/products/sync', async (req, res) => {
  try {
    const { products } = req.body;

    if (!Array.isArray(products)) {
      return res.status(400).json({
        success: false,
        message: 'Products must be an array'
      });
    }

    const bulkOps = products.map(item => {
      // Use sku or barcode as unique identifier
      const filter = {};
      if (item.sku) filter.sku = item.sku;
      else if (item.barcode) filter.barcode = item.barcode;
      else return null; // Skip if no ID

      const update = {
        $set: {
          name: item.name,
          price: parseFloat(item.price),
          mrp: parseFloat(item.mrp || item.price),
          stock: parseInt(item.stock || 0),
          category: item.category || 'pantry',
          unit: item.unit || 'piece',
          description: item.description || item.name,
          'tax.gstRate': parseFloat(item.gst || 0),
          isActive: item.isActive !== undefined ? item.isActive : true,
          lastSynced: new Date()
        }
      };

      return {
        updateOne: {
          filter,
          update,
          upsert: true
        }
      };
    }).filter(Boolean);

    if (bulkOps.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid products with SKU or Barcode found'
      });
    }

    const result = await Product.bulkWrite(bulkOps);

    res.json({
      success: true,
      message: 'Sync completed successfully',
      stats: {
        matched: result.matchedCount,
        modified: result.modifiedCount,
        upserted: result.upsertedCount
      }
    });
  } catch (error) {
    console.error('Admin sync products error:', error);
    res.status(500).json({ success: false, message: 'Failed to sync products' });
  }
});


// Auto-Fetch Images (Batch Process)
router.post('/products/fetch-images', async (req, res) => {
  console.log('[Fetch Images] Request received');
  try {
    const BATCH_SIZE = 20; // Increased batch size for max speed

    // Find products without images
    const products = await Product.find({
      $or: [{ image: '' }, { image: null }, { image: { $exists: false } }]
    }).limit(BATCH_SIZE);

    console.log(`[Fetch Images] Found ${products.length} products to process`);

    if (products.length === 0) {
      return res.json({ success: true, message: 'No products need images', completed: true });
    }

    let updatedCount = 0;
    const results = [];

    for (const product of products) {
      let imageUrl = '';

      // Common headers for OpenFoodFacts
      const headers = {
        'User-Agent': 'NellaiRehoboth - Android - Version 1.0 - www.nellairehoboth.com'
      };

      console.log(`[Fetch Images] Processing ${product.name} (Barcode: ${product.barcode})`);

      // Strategy 1: Name Search (Priority - Faster & Higher Hit Rate)
      if (product.name) {
        try {
          const searchRes = await axios.get(`https://world.openfoodfacts.org/cgi/search.pl`, {
            params: {
              search_terms: product.name,
              search_simple: 1,
              action: 'process',
              json: 1,
              page_size: 1
            },
            headers
          });

          if (searchRes.data && searchRes.data.products && searchRes.data.products.length > 0) {
            imageUrl = searchRes.data.products[0].image_front_url || searchRes.data.products[0].image_url || '';
          }
        } catch (err) {
          console.error(`[Fetch Images] Name search error for ${product.name}:`, err.message);
        }
      }

      // Strategy 2: Barcode Search (Fallback)
      if (!imageUrl && product.barcode) {
        try {
          const barcodeRes = await axios.get(`https://world.openfoodfacts.org/api/v0/product/${product.barcode}.json`, { headers });
          if (barcodeRes.data && barcodeRes.data.status === 1) {
            imageUrl = barcodeRes.data.product.image_front_url || barcodeRes.data.product.image_url || '';
          }
        } catch (err) {
          console.error(`[Fetch Images] Barcode search error for ${product.barcode}:`, err.message);
        }
      }

      // Update product if image found
      if (imageUrl) {
        console.log(`[Fetch Images] Found image for ${product.name}`);
        // Use updateOne/findByIdAndUpdate to bypass full document validation (which fails on missing description/unit)
        await Product.findByIdAndUpdate(product._id, { image: imageUrl });
        updatedCount++;
        results.push({ name: product.name, found: true });
      } else {
        console.log(`[Fetch Images] No image found for ${product.name}`);
        // Mark as skipped/not-found to avoid endless retrying?
        // For now, we won't mark it, so it might be retried or user can manually edit.
        // potentially add a flag 'imageFetchFailed' to skip next time
        // or just leave it blank.
        results.push({ name: product.name, found: false });
      }

      // Polite delay between requests
      await new Promise(r => setTimeout(r, 500));
    }

    const remaining = await Product.countDocuments({
      $or: [{ image: '' }, { image: null }, { image: { $exists: false } }]
    });

    res.json({
      success: true,
      updated: updatedCount,
      processed: products.length,
      remaining,
      completed: remaining === 0
    });

  } catch (error) {
    console.error('Fetch images error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch images', error: String(error), stack: error.stack });
  }
});

// Get all orders (admin view)
router.get('/orders', async (req, res) => {
  try {
    const orders = await Order.find({})
      .populate('user', 'name email')
      .populate('items.product', 'name')
      .sort({ createdAt: -1 });

    res.json({ success: true, orders });
  } catch (error) {
    console.error('Admin get orders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
});

// Update order status
router.put('/orders/:id', async (req, res) => {
  try {
    const { status } = req.body;

    if (!status || ![
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
    ].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Valid status is required'
      });
    }

    const orderBefore = await Order.findById(req.params.id).select('status');
    if (!orderBefore) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const normalize = (s) => {
      const map = {
        pending: 'CREATED',
        confirmed: 'ADMIN_CONFIRMED',
        processing: 'ADMIN_CONFIRMED',
        shipped: 'SHIPPED',
        delivered: 'DELIVERED',
        cancelled: 'CANCELLED',
      };
      return map[s] || s;
    };

    const from = normalize(orderBefore.status);
    const to = normalize(status);

    const allowedNext = {
      CREATED: ['PAYMENT_PENDING', 'PAID', 'ADMIN_CONFIRMED', 'CANCELLED'],
      PAYMENT_PENDING: ['PAID', 'CANCELLED'],
      PAID: ['ADMIN_CONFIRMED', 'CANCELLED'],
      ADMIN_CONFIRMED: ['SHIPPED', 'CANCELLED'],
      SHIPPED: ['DELIVERED'],
      DELIVERED: [],
      CANCELLED: [],
    };

    // Allow idempotent set (no-op)
    if (from !== to) {
      const ok = (allowedNext[from] || []).includes(to);
      if (!ok) {
        return res.status(400).json({
          success: false,
          message: `Invalid status transition: ${orderBefore.status} → ${status}`
        });
      }
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('user', 'name email');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // If admin set to cancelled, send cancellation email (best-effort)
    if (order && (status === 'CANCELLED' || status === 'cancelled')) {
      const userId = order.user?._id || order.user; // populated or raw ObjectId
      sendOrderCancelEmailNotification(order, userId).catch(() => { });
    }

    res.json({
      success: true,
      order,
      message: 'Order status updated successfully'
    });
  } catch (error) {
    console.error('Admin update order error:', error);
    res.status(500).json({ success: false, message: 'Failed to update order' });
  }
});

// Get dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments({ isActive: true });
    const totalOrders = await Order.countDocuments({});
    const totalUsers = await User.countDocuments({});
    const pendingOrders = await Order.countDocuments({ status: { $in: ['CREATED', 'PAYMENT_PENDING', 'pending'] } });

    const totalRevenue = await Order.aggregate([
      { $match: { status: { $nin: ['CANCELLED', 'cancelled'] } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);

    const recentOrders = await Order.find({})
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      success: true,
      stats: {
        totalProducts,
        totalOrders,
        totalUsers,
        pendingOrders,
        totalRevenue: totalRevenue[0]?.total || 0,
        recentOrders
      }
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// Maintenance: Fix invalid user roles (set to 'customer')
router.post('/maintenance/fix-roles', async (req, res) => {
  try {
    const result = await User.updateMany(
      { role: { $nin: ['customer', 'admin'] } },
      { $set: { role: 'customer' } }
    );

    res.json({
      success: true,
      modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
      message: 'Invalid roles normalized to customer'
    });
  } catch (error) {
    console.error('Admin maintenance fix-roles error:', error);
    res.status(500).json({ success: false, message: 'Failed to normalize roles' });
  }
});

module.exports = router;
