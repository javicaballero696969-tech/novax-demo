const express = require("express");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "novax-demo-secret-change-me";
const db = new Database(process.env.DB_PATH || path.join(__dirname, "novax.sqlite"));

db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS balances (
  user_id INTEGER NOT NULL,
  asset TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, asset)
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  amount REAL NOT NULL,
  price REAL NOT NULL,
  total REAL NOT NULL,
  created_at TEXT NOT NULL
);
`);

const MARKET = {
  BTC:{name:"Bitcoin",price:105420.00,change:2.31},
  ETH:{name:"Ethereum",price:3815.42,change:1.72},
  SOL:{name:"Solana",price:221.84,change:4.16},
  XRP:{name:"XRP",price:2.91,change:-0.84},
  BNB:{name:"BNB",price:742.18,change:1.08}
};

function marketSnapshot(){
  const out={};
  for(const [symbol,m] of Object.entries(MARKET)){
    const drift=(Math.random()-0.48)*0.0025;
    m.price=+(m.price*(1+drift)).toFixed(symbol==="BTC"?2:4);
    out[symbol]={...m};
  }
  return out;
}

function hashPassword(password,salt){
  return crypto.scryptSync(password,salt,64).toString("hex");
}
function auth(req,res,next){
  const h=req.headers.authorization||"";
  if(!h.startsWith("Bearer ")) return res.status(401).json({error:"Authentication required"});
  try{
    req.user=jwt.verify(h.slice(7),JWT_SECRET);
    next();
  }catch{return res.status(401).json({error:"Invalid session"});}
}

app.use(express.json({limit:"100kb"}));

app.get("/api/health",(req,res)=>res.json({ok:true,service:"novax-demo"}));
app.get("/api/market",(req,res)=>res.json(marketSnapshot()));

app.post("/api/register",(req,res)=>{
  const {name,email,password}=req.body||{};
  if(!name||!email||!password||password.length<6)
    return res.status(400).json({error:"Name, email and a password of at least 6 characters are required"});
  const normalized=String(email).trim().toLowerCase();
  const exists=db.prepare("SELECT id FROM users WHERE email=?").get(normalized);
  if(exists) return res.status(409).json({error:"An account with that email already exists"});
  const salt=crypto.randomBytes(16).toString("hex");
  const password_hash=hashPassword(password,salt);
  const info=db.prepare("INSERT INTO users(name,email,password_hash,salt,created_at) VALUES(?,?,?,?,?)")
    .run(String(name).trim(),normalized,password_hash,salt,new Date().toISOString());
  const userId=info.lastInsertRowid;
  const insertBalance=db.prepare("INSERT INTO balances(user_id,asset,amount) VALUES(?,?,?)");
  insertBalance.run(userId,"USD",25000);
  for(const a of Object.keys(MARKET)) insertBalance.run(userId,a,0);
  const token=jwt.sign({id:userId,email:normalized},JWT_SECRET,{expiresIn:"7d"});
  res.json({token});
});

app.post("/api/login",(req,res)=>{
  const {email,password}=req.body||{};
  const user=db.prepare("SELECT * FROM users WHERE email=?").get(String(email||"").trim().toLowerCase());
  if(!user||hashPassword(String(password||""),user.salt)!==user.password_hash)
    return res.status(401).json({error:"Invalid email or password"});
  const token=jwt.sign({id:user.id,email:user.email},JWT_SECRET,{expiresIn:"7d"});
  res.json({token});
});

app.get("/api/me",auth,(req,res)=>{
  const user=db.prepare("SELECT id,name,email,created_at FROM users WHERE id=?").get(req.user.id);
  if(!user) return res.status(404).json({error:"User not found"});
  res.json(user);
});

app.get("/api/portfolio",auth,(req,res)=>{
  const rows=db.prepare("SELECT asset,amount FROM balances WHERE user_id=?").all(req.user.id);
  const market=marketSnapshot();
  let total=0;
  const balances=rows.map(r=>{
    const value=r.asset==="USD"?r.amount:r.amount*(market[r.asset]?.price||0);
    total+=value;
    return {...r,value};
  });
  res.json({balances,totalValue:total,market});
});

app.get("/api/trades",auth,(req,res)=>{
  res.json(db.prepare("SELECT id,symbol,side,amount,price,total,created_at FROM trades WHERE user_id=? ORDER BY id DESC LIMIT 50").all(req.user.id));
});

app.post("/api/trade",auth,(req,res)=>{
  const {symbol,side,amount}=req.body||{};
  const qty=Number(amount);
  if(!MARKET[symbol]||!["buy","sell"].includes(side)||!Number.isFinite(qty)||qty<=0)
    return res.status(400).json({error:"Invalid trade"});
  const price=MARKET[symbol].price;
  const total=qty*price;
  const get=db.prepare("SELECT amount FROM balances WHERE user_id=? AND asset=?");
  const set=db.prepare("UPDATE balances SET amount=? WHERE user_id=? AND asset=?");
  const usd=get.get(req.user.id,"USD")?.amount||0;
  const coin=get.get(req.user.id,symbol)?.amount||0;
  const tx=db.transaction(()=>{
    if(side==="buy"){
      if(usd<total) throw new Error("Insufficient USD balance");
      set.run(usd-total,req.user.id,"USD");
      set.run(coin+qty,req.user.id,symbol);
    }else{
      if(coin<qty) throw new Error("Insufficient asset balance");
      set.run(coin-qty,req.user.id,symbol);
      set.run(usd+total,req.user.id,"USD");
    }
    db.prepare("INSERT INTO trades(user_id,symbol,side,amount,price,total,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(req.user.id,symbol,side,qty,price,total,new Date().toISOString());
  });
  try{tx();res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}
});

app.use(express.static(path.join(__dirname,"public")));

// Express 5-safe SPA fallback: API routes above are handled first.
app.use((req,res)=>{
  if(req.method==="GET" && !req.path.startsWith("/api/"))
    return res.sendFile(path.join(__dirname,"public","index.html"));
  res.status(404).json({error:"Not found"});
});

app.listen(PORT,"0.0.0.0",()=>console.log(`NovaX listening on port ${PORT}`));
