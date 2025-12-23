const express = require('express');
const Product = require('../models/Product');
const { authenticateToken } = require('./auth');
const router = express.Router();

// Get all products with filtering and search
router.get('/', async (req, res) => {
  try {
    const {
      search,
      category,
      minPrice,
      maxPrice,
      sortBy = 'name',
      limit = 50,
      page = 1,
      featured
    } = req.query;

    let query = { isActive: true };

    // Search functionality
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } }
      ];
    }

    // Category filter
    if (category) {
      query.category = category;
    }

    // Price range filter
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = parseFloat(minPrice);
      if (maxPrice) query.price.$lte = parseFloat(maxPrice);
    }

    // Featured products (for homepage)
    if (featured === 'true') {
      query.stock = { $gt: 0 };
    }

    // Sorting
    let sortOptions = {};
    switch (sortBy) {
      case 'price':
        sortOptions.price = 1;
        break;
      case '-price':
        sortOptions.price = -1;
        break;
      case 'category':
        sortOptions.category = 1;
        break;
      case '-createdAt':
        sortOptions.createdAt = -1;
        break;
      default:
        sortOptions.name = 1;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const products = await Product.find(query)
      .sort(sortOptions)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Product.countDocuments(query);

    res.json({
      success: true,
      products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch products' });
  }
});

// Get single product
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    res.json({ success: true, product });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch product' });
  }
});

// Create sample products (for demo)
router.post('/seed', async (req, res) => {
  try {
    const sampleProducts = [
      // Fruits
      {
        name: 'Fresh Apples',
        description: 'Crisp and sweet red apples, perfect for snacking',
        price: 120,
        category: 'fruits',
        stock: 50,
        unit: 'kg',
        image: '',
        tags: ['fresh', 'organic', 'healthy']
      },
      {
        name: 'Fresh Bananas',
        description: 'Sweet and nutritious yellow bananas, great for smoothies',
        price: 60,
        category: 'fruits',
        stock: 80,
        unit: 'dozen',
        image: '',
        tags: ['fresh', 'sweet', 'healthy', 'potassium']
      },
      {
        name: 'Seedless Grapes',
        description: 'Juicy seedless green grapes',
        price: 180,
        category: 'fruits',
        stock: 35,
        unit: 'kg',
        image: '',
        tags: ['fresh', 'snack', 'vitamin']
      },
      {
        name: 'Alphonso Mangoes',
        description: 'Seasonal premium mangoes, naturally sweet',
        price: 250,
        category: 'fruits',
        stock: 20,
        unit: 'kg',
        image: '',
        tags: ['seasonal', 'sweet', 'dessert']
      },

      // Vegetables
      {
        name: 'Fresh Tomatoes',
        description: 'Ripe and juicy tomatoes, great for cooking',
        price: 80,
        category: 'vegetables',
        stock: 40,
        unit: 'kg',
        image: '',
        tags: ['fresh', 'organic', 'cooking']
      },
      {
        name: 'Onions',
        description: 'Red onions, essential for everyday cooking',
        price: 45,
        category: 'vegetables',
        stock: 70,
        unit: 'kg',
        image: '',
        tags: ['staple', 'cooking']
      },
      {
        name: 'Potatoes',
        description: 'Farm-fresh potatoes ideal for fries and curries',
        price: 40,
        category: 'vegetables',
        stock: 90,
        unit: 'kg',
        image: '',
        tags: ['staple', 'carbs']
      },
      {
        name: 'Spinach (Palak)',
        description: 'Green leafy spinach, iron-rich and fresh',
        price: 30,
        category: 'vegetables',
        stock: 50,
        unit: 'pack',
        image: '',
        tags: ['leafy', 'iron', 'healthy']
      },

      // Dairy & Bakery
      {
        name: 'Whole Milk',
        description: 'Fresh whole milk, rich in calcium and protein',
        price: 60,
        category: 'dairy',
        stock: 30,
        unit: 'liter',
        image: '',
        tags: ['fresh', 'dairy', 'protein']
      },
      {
        name: 'Greek Yogurt',
        description: 'Creamy and protein-rich Greek yogurt, perfect for breakfast',
        price: 85,
        category: 'dairy',
        stock: 25,
        unit: 'pack',
        image: '',
        tags: ['healthy', 'protein', 'breakfast', 'probiotic']
      },
      {
        name: 'Paneer (Cottage Cheese)',
        description: 'Fresh paneer perfect for curries and snacks',
        price: 120,
        category: 'dairy',
        stock: 40,
        unit: 'pack',
        image: '',
        tags: ['protein', 'vegetarian']
      },
      {
        name: 'Brown Bread',
        description: 'Healthy whole wheat brown bread',
        price: 40,
        category: 'bakery',
        stock: 25,
        unit: 'piece',
        image: '',
        tags: ['fresh', 'healthy', 'wheat']
      },

      // Meat & Frozen
      {
        name: 'Chicken Breast',
        description: 'Skinless, boneless chicken breast',
        price: 280,
        category: 'meat',
        stock: 25,
        unit: 'kg',
        image: '',
        tags: ['protein', 'lean']
      },
      {
        name: 'Frozen Peas',
        description: 'Tender green peas, frozen to lock freshness',
        price: 95,
        category: 'frozen',
        stock: 50,
        unit: 'pack',
        image: '',
        tags: ['frozen', 'vegetable']
      },

      // Beverages & Snacks
      {
        name: 'Orange Juice',
        description: 'Fresh squeezed orange juice, vitamin C rich',
        price: 90,
        category: 'beverages',
        stock: 35,
        unit: 'liter',
        image: '',
        tags: ['fresh', 'vitamin', 'healthy']
      },
      {
        name: 'Assorted Soft Drink',
        description: 'Carbonated beverage assorted flavors 1.25L',
        price: 75,
        category: 'beverages',
        stock: 60,
        unit: 'liter',
        image: '',
        tags: ['cold', 'party']
      },
      {
        name: 'Potato Chips',
        description: 'Crispy and salted potato chips',
        price: 50,
        category: 'snacks',
        stock: 60,
        unit: 'pack',
        image: '',
        tags: ['snack', 'crispy', 'salty']
      },
      {
        name: 'Masala Nuts',
        description: 'Roasted spiced peanuts for quick snack',
        price: 90,
        category: 'snacks',
        stock: 45,
        unit: 'pack',
        image: '',
        tags: ['snack', 'protein']
      },

      // Pantry
      {
        name: 'Basmati Rice',
        description: 'Long-grain aromatic basmati rice',
        price: 160,
        category: 'pantry',
        stock: 70,
        unit: 'kg',
        image: '',
        tags: ['staple', 'grain']
      },
      {
        name: 'Wheat Flour (Atta)',
        description: 'Whole wheat flour for soft rotis',
        price: 55,
        category: 'pantry',
        stock: 90,
        unit: 'kg',
        image: '',
        tags: ['staple', 'flour']
      },
      {
        name: 'Sunflower Oil',
        description: 'Refined sunflower cooking oil',
        price: 160,
        category: 'pantry',
        stock: 60,
        unit: 'liter',
        image: '',
        tags: ['cooking', 'oil']
      },
      {
        name: 'Toor Dal (Arhar)',
        description: 'Protein-rich split pigeon peas',
        price: 140,
        category: 'pantry',
        stock: 80,
        unit: 'kg',
        image: '',
        tags: ['lentils', 'protein']
      },

      // Household
      {
        name: 'Dishwashing Liquid',
        description: 'Lemon-scented grease-cutting dishwash liquid',
        price: 110,
        category: 'household',
        stock: 40,
        unit: 'pack',
        image: '',
        tags: ['cleaning', 'kitchen']
      },
      {
        name: 'Laundry Detergent',
        description: 'Front-load compatible liquid detergent',
        price: 260,
        category: 'household',
        stock: 35,
        unit: 'liter',
        image: '',
        tags: ['cleaning', 'clothes']
      },

      // More Fruits
      {
        name: 'Pomegranates',
        description: 'Antioxidant-rich fresh pomegranates',
        price: 220,
        category: 'fruits',
        stock: 30,
        unit: 'kg',
        image: '',
        tags: ['antioxidant', 'fresh']
      },
      {
        name: 'Oranges',
        description: 'Juicy oranges loaded with vitamin C',
        price: 90,
        category: 'fruits',
        stock: 55,
        unit: 'kg',
        image: '',
        tags: ['vitamin c', 'citrus']
      },

      // More Vegetables
      {
        name: 'Cucumbers',
        description: 'Fresh cucumbers perfect for salads',
        price: 50,
        category: 'vegetables',
        stock: 60,
        unit: 'kg',
        image: '',
        tags: ['salad', 'hydrating']
      },
      {
        name: 'Carrots',
        description: 'Crunchy orange carrots rich in beta-carotene',
        price: 70,
        category: 'vegetables',
        stock: 65,
        unit: 'kg',
        image: '',
        tags: ['vitamin a', 'healthy']
      },
      {
        name: 'Cauliflower',
        description: 'Fresh cauliflower, versatile for many dishes',
        price: 55,
        category: 'vegetables',
        stock: 40,
        unit: 'piece',
        image: '',
        tags: ['low carb', 'cooking']
      },

      // More Dairy & Bakery
      {
        name: 'Butter',
        description: 'Creamy table butter, salted',
        price: 55,
        category: 'dairy',
        stock: 80,
        unit: 'pack',
        image: '',
        tags: ['dairy', 'spread']
      },
      {
        name: 'Cheddar Cheese',
        description: 'Sharp cheddar cheese block',
        price: 210,
        category: 'dairy',
        stock: 25,
        unit: 'pack',
        image: '',
        tags: ['cheese', 'snack']
      },
      {
        name: 'Multigrain Bread',
        description: 'Soft multigrain loaf with seeds',
        price: 55,
        category: 'bakery',
        stock: 30,
        unit: 'piece',
        image: '',
        tags: ['bread', 'healthy']
      },
      {
        name: 'Eggs (Farm Fresh)',
        description: 'Protein-rich eggs - pack of 12',
        price: 85,
        category: 'dairy',
        stock: 50,
        unit: 'dozen',
        image: '',
        tags: ['protein', 'breakfast']
      },

      // More Snacks & Beverages
      {
        name: 'Chocolate Cookies',
        description: 'Crispy double-chocolate chip cookies',
        price: 120,
        category: 'snacks',
        stock: 45,
        unit: 'pack',
        image: '',
        tags: ['snack', 'sweet']
      },
      {
        name: 'Green Tea',
        description: 'Antioxidant-rich green tea bags (25 count)',
        price: 160,
        category: 'beverages',
        stock: 40,
        unit: 'pack',
        image: '',
        tags: ['tea', 'healthy']
      },

      // More Pantry
      {
        name: 'Chana Dal',
        description: 'Split chickpeas used in dals and snacks',
        price: 95,
        category: 'pantry',
        stock: 70,
        unit: 'kg',
        image: '',
        tags: ['lentils', 'protein']
      },
      {
        name: 'Sugar',
        description: 'Fine granulated white sugar',
        price: 48,
        category: 'pantry',
        stock: 120,
        unit: 'kg',
        image: '',
        tags: ['sweetener', 'baking']
      },
      {
        name: 'Iodized Salt',
        description: 'Refined iodized table salt',
        price: 25,
        category: 'pantry',
        stock: 150,
        unit: 'kg',
        image: '',
        tags: ['staple', 'seasoning']
      },
      {
        name: 'Pasta (Penne)',
        description: 'Durum wheat penne pasta',
        price: 75,
        category: 'pantry',
        stock: 80,
        unit: 'pack',
        image: '',
        tags: ['italian', 'quick meal']
      },

      // More Household
      {
        name: 'Toilet Paper',
        description: 'Soft and strong tissue rolls (4 pack)',
        price: 140,
        category: 'household',
        stock: 60,
        unit: 'pack',
        image: '',
        tags: ['tissue', 'home']
      },
      {
        name: 'Garbage Bags',
        description: 'Black garbage bags, medium size (30 count)',
        price: 110,
        category: 'household',
        stock: 70,
        unit: 'pack',
        image: '',
        tags: ['cleaning', 'disposal']
      }
    ];

    // Clear existing products
    await Product.deleteMany({});
    
    // Insert sample products
    await Product.insertMany(sampleProducts);

    res.json({ 
      success: true, 
      message: `${sampleProducts.length} sample products created successfully` 
    });
  } catch (error) {
    console.error('Seed products error:', error);
    res.status(500).json({ success: false, message: 'Failed to create sample products' });
  }
});

// Delete product (admin only)
router.delete('/:id', authenticateToken, async (req, res) => {
  // Check if user is admin
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete product' });
  }
});

module.exports = router;
