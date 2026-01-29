# 🎓 The Developer's Guide to Thinking in Classes

You asked a fantastic question. Many developers stay in "Function Land" forever because it's comfortable. But understanding "Class Land" (Object-Oriented Programming or OOP) unlocks a new level of architectural power.

Here is your crash course on **Why, When, and How** to use Classes and Design Patterns in JavaScript/TypeScript.

---

## 1. The Mental Shift: Functions vs. Classes

### 🛠️ The "Function" Mindset (Functional)

- **Philosophy:** "Data in, Data out."
- **Best for:** Pure calculations, data transformations, simple utilities.
- **Weakness:** Managing **State** (memory/data that changes over time) gets messy. You end up passing `options` and `config` into every single function, or using global variables (which is bad).

**Example (Messy):**

```ts
// You have to pass 'config' everywhere!
function convertImage(file, config) { ... }
function uploadImage(file, config) { ... }
function logError(error, config) { ... }
```

### 🏛️ The "Class" Mindset (Object-Oriented)

- **Philosophy:** "I am an Entity. I hold my own Data (State) and I have Skills (Methods) to use it."
- **Best for:** "Services", "Managers", "Handlers" — things that exist over time and hold information.
- **Strength:** Encapsulation. You setup the object **once** with its config, and then it just "knows" what to do.

**Example (Clean):**

```ts
class ImageProcessor {
    constructor(private config: Config) {} // Setup once!

    convert(file) {
        // I already know my config!
        if (this.config.format === 'webp') { ... }
    }
}
```

---

## 2. Design Patterns You Must Know

Design patterns are just "common solutions to common problems". Here are the Top 3 you will use 90% of the time.

### 🏆 1. The Singleton (The "Highlander": There can be only one)

**Use when:** You need **Shared State** across your entire app (Configuration, Database Connection, Cache).
**Analogy:** The "Announcement Speaker" in a school. Use the same speaker to talk to everyone.

**Code Pattern:**

```ts
class Database {
  private static instance: Database; // The only instance

  // Private constructor: NOBODY can do "new Database()"
  private constructor() {
    console.log("Connected to DB");
  }

  static getInstance() {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }
}

// Usage
const db1 = Database.getInstance();
const db2 = Database.getInstance();
console.log(db1 === db2); // true! They are the exact same object.
```

- **In Upfly:** We used this for `ConfigService`. We don't want 5 different versions of "Settings" floating around.

### 🏭 2. The Factory (The "Manufacturer")

**Use when:** You need to create objects, but you don't know _which one_ until runtime.
**Analogy:** A "Car Factory". You tell it "I want a Sedan", it gives you a Sedan. You don't need to know how to build it.

**Code Pattern:**

```ts
class CloudFactory {
  static createAdapter(provider: string) {
    if (provider === "aws") return new S3Adapter();
    if (provider === "google") return new GCSAdapter();
    throw new Error("Unknown Cloud");
  }
}

// Usage
const myCloud = CloudFactory.createAdapter("aws");
myCloud.upload(file); // I don't care if it's AWS or Google, I just upload.
```

- **In Upfly:** Your `upfly` library's `createCloudAdapter` is exactly this!

### 📡 3. The Observer (The "News Anchor")

**Use when:** Something happens, and many other things need to know about it.
**Analogy:** Subscribing to a Newsletter. When the publisher sends one email, 1000 people get it.

**Code Pattern:**

```ts
class ConfigService {
  // The list of subscribers
  private listeners = [];

  // Allow people to subscribe
  onConfigChange(fn) {
    this.listeners.push(fn);
  }

  // Notify everyone
  updateConfig() {
    // ... update logic ...
    this.listeners.forEach((fn) => fn()); // Fire!
  }
}
```

- **In Upfly:** VS Code's `onDidChangeConfiguration` uses this pattern. We "subscribe" to it in `extension.ts`.

---

## 3. Best Practices (How to write "Pro" Code)

If you follow these rules (S.O.L.I.D principles simplified), your code will be better than 90% of developers.

### ✅ 1. Single Responsibility Principle (SRP)

**Rule:** A class should do **ONE THING** and do it well.

- **Bad:** `GodClass` that reads files, converts images, _and_ uploads to cloud.
- **Good:**
  - `WatcherService`: Only watches files.
  - `ConverterService`: Only converts images.
  - `CloudService`: Only uploads.
  - _Result:_ If cloud uploading breaks, you know exactly where to look. You don't break the Watcher while fixing the Cloud.

### ✅ 2. Dependency Injection (DI)

**Rule:** Don't hardcode dependencies inside a class. Pass them in.
Makes testing easy because you can pass "fake" dependencies.

- **Bad:**
  ```ts
  class User {
    save() {
      // Hardcoded! What if I want to test without a real DB?
      const db = new Database();
      db.write(this);
    }
  }
  ```
- **Good (Injecting):**
  ```ts
  class User {
    constructor(private db: Database) {} // Pass it in!
    save() {
      this.db.write(this);
    }
  }
  ```

### ✅ 3. Private by Default

**Rule:** Hide everything. Only expose what is necessary (`public`).

- This protects your internal logic from being messed with by other code.
- In `WatcherService`, `debounceTimers` is private. No external code should ever touch the timers directly.

---

## 🚀 Summary: When to use which?

| Scenario                                             | Use Function 🔧 | Use Class 🏛️                 |
| :--------------------------------------------------- | :-------------- | :--------------------------- |
| **Simple Utils** (Math, Strings)                     | ✅ YES          | ❌ Overkill                  |
| **Data Transformation** (Array.map)                  | ✅ YES          | ❌ Overkill                  |
| **State Management** (Cache, Config, User Session)   | ❌ Messy        | ✅ YES (perfect)             |
| **Complex Processes** (Lifecycles, Startup/Shutdown) | ❌ Hard         | ✅ YES (Constructor/Dispose) |
| **Services** (API Clients, Database wrappers)        | ❌ Hard         | ✅ YES                       |

You are already using these patterns in `upfly-vscode`.

- `WatcherService` holds state (the list of active watchers).
- `ConfigService` holds state (the settings).
- `ProcessingCache` holds state (the set of files to ignore).

That is why we used Classes there!
