# 🏗️ Architecture Patterns: A Deep Dive with Examples

You asked for the details—so let's break it down with a real-world scenario: **Processing an E-commerce Order**.

We will build the _same feature_ twice:

1.  **MVC (The Simple Way)**
2.  **Clean Architecture (The Enterprise Way)**

---

## Scenario: "Place an Order"

When a user buys something, we need to:

1.  Check stock.
2.  Save the order to the Database.
3.  Send a Confirmation Email.

---

## 1. MVC (Model - View - Controller)

**Philosophy:** Get it done fast. Put logic in the Controller.

### ❌ The Code (Fat Controller)

```typescript
// OrderController.ts
import { database } from "./db";
import { emailer } from "./utils";

class OrderController {
  async placeOrder(req, res) {
    const { itemId, userId } = req.body;

    // 1. Direct Database Logic (Tightly Coupled)
    const item = await database.query(
      `SELECT * FROM items WHERE id = ${itemId}`,
    );

    if (item.stock < 1) {
      return res.status(400).send("Out of stock");
    }

    // 2. Business Logic mixed with DB logic
    const order = { userId, itemId, date: new Date() };
    await database.query("INSERT INTO orders ...", order);

    // 3. Side Effects mixed in
    await emailer.send(userId, "Order Placed!");

    return res.json({ success: true });
  }
}
```

**Why this fails at scale:**

- What if we want to switch from SQL to MongoDB? We have to rewrite the Controller.
- What if we want to test "Out of Stock" logic? We have to mocking the whole Database.
- The Controller does _everything_. It's a "God Object".

---

## 2. Clean Architecture (The "Onion")

**Philosophy:** The "Business Logic" is sacred. It should not know that a Database or Emailer even exists.

### Layer 1: The Core (Entities)

_Pure Logic only. No database code here._

```typescript
// domain/Order.ts
export class Order {
  constructor(
    public id: string,
    public userId: string,
    public items: Item[],
  ) {}

  // Pure business rule
  totalPrice() {
    return this.items.reduce((sum, item) => sum + item.price, 0);
  }
}
```

### Layer 2: The Use Case (The Application Logic)

_Orchestrates the flow. Defines "Interfaces" (contracts) for what it needs._

```typescript
// usecases/PlaceOrder.ts
interface IOrderRepo {
  // The Contract
  save(order: Order): Promise<void>;
  findItem(id: string): Promise<Item>;
}

interface INotificationService {
  // The Contract
  send(to: string, msg: string): Promise<void>;
}

export class PlaceOrderUseCase {
  // Inject dependencies! depend on Interfaces, not classes.
  constructor(
    private repo: IOrderRepo,
    private notifier: INotificationService,
  ) {}

  async execute(userId: string, itemId: string) {
    const item = await this.repo.findItem(itemId);

    if (item.stock < 1) {
      throw new Error("Out of Stock");
    }

    const order = new Order(generateId(), userId, [item]);

    await this.repo.save(order);
    await this.notifier.send(userId, "Order Placed!");
  }
}
```

- **Notice:** This file has 0 imports from libraries. It acts on pure logic.

### Layer 3: The Adapters (The Real World)

_Now we actually implement those interfaces._

```typescript
// adapters/SqlOrderRepository.ts
import { database } from "pg"; // Postgres

class SqlOrderRepository implements IOrderRepo {
  async findItem(id) {
    return database.query(`SELECT ...`);
  }
  async save(order) {
    return database.query(`INSERT ...`);
  }
}
```

### Layer 4: The Glue (Dependency Injection)

_Wire it all together at startup._

```typescript
// index.ts
const repo = new SqlOrderRepository(); // The Tool
const mailer = new SendGridMailer(); // The Tool
const useCase = new PlaceOrderUseCase(repo, mailer); // The Brain

// Now the controller is super dumb:
controller.post("/order", async (req) => {
  await useCase.execute(req.body.userId, req.body.itemId);
});
```

---

## 🆚 Final Comparison

| Feature            | MVC                                    | Clean Architecture                  |
| :----------------- | :------------------------------------- | :---------------------------------- |
| **Speed to Build** | 🏎️ Very Fast                           | 🐢 Slow (Lots of files)             |
| **Clarity**        | Easy to read (everything in one place) | Abstract (jumping between files)    |
| **Testing**        | Hard (Must mock Database)              | Easy (Pass fake objects to UseCase) |
| **Flexibility**    | Low (Hard to change DB)                | High (Swap Repositories easily)     |

### 💡 My Recommendation

- **Start with Modular MVC.** (Keep Controllers skinny, move logic to Services).
- **Refactor to Clean Arch** ONLY when your Services get too messy or you need to support multiple platforms (Web + Mobile + CLI).
