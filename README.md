# Kusina Moderna  Web Based Food Order Recording System for Small Food Businesses

**Brand:** Kusina Moderna (*Elevated Lutong Bahay  Home Cooked Classics with a Twist*)  
**Course:** IT 314 Web Systems & Technologies  BSIT 3107  
**Group:** Group 11 (Business Analytics Track)  
**Members / Admins:** Brendan Roy Sales, Markaaron Suayan, Justinrhoss Martinez

---

## Project Overview

A lightweight, monochrome Apple-minimalist full-stack web application built with **semantic HTML5, plain CSS3, Vanilla JavaScript (ES6+), Node.js, Express.js, and Chart.js v4**, backed by a local JSON datastore (`data/database.json`).

### Core Features
- **Public Customer Website:** Browse the 15 dish *Elevated Lutong Bahay* menu, inspect dish details, place Online Dine In or Take Out orders, track live order status, and submit 1 to 5 star ratings on completed orders.
- **Silent Customer Behavior Telemetry:** Tracks unique session page views, menu item clicks, category interest, and menu browse duration before checkout feeding directly into Business Analytics without interrupting customer flow.
- **Staff / Cashier Portal (`staff` role):** Restricted operational access to Walk In POS order recording, Live Order Queue with status updates & printable receipts, and Quick Stock Toggle.
- **Admin / Owner Portal (`admin` role):** Full operational control plus an Owner Revenue & Customer Behavior Analytics Command Center (8 KPIs, Daily Revenue Target tracker, 4 interactive Chart.js charts, automated BA insights, 4 analytical tables, Excel safe UTF 8 CSV exports, Menu CRUD, and Account Management).

---

## Local Setup & Run

Requires **Node.js v22+**.

```bash
npm install --legacy-peer-deps(if npm install failed use legacy cuh)
npm install
npm start
```

Open your browser to `http://localhost:3000`.


## Default Demo Accounts

| Role  | Username       | Password     |
|-------|----------------|--------------|
| Staff | `StaffniSales` | `Staff234`   |
| Admin | `Brendan`      | `BSUProj234` |
| Admin | `Markaaron`    | `BSUProj234` |
| Admin | `Justin`       | `BSUProj234` |
