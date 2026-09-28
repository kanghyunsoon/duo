package com.example.orders;

import org.springframework.stereotype.Service;

@Service
public class OrderService {
  public Order place(String sku, int quantity) {
    validate(quantity);
    return new Order(sku, quantity);
  }

  private void validate(int quantity) {
    if (quantity <= 0) throw new IllegalArgumentException("quantity");
  }
}
