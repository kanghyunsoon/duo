package com.example.orders;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
  private final OrderService service;

  public OrderController(OrderService service) {
    this.service = service;
  }

  @PostMapping("/orders")
  public Order create(@RequestParam String sku, @RequestParam int quantity) {
    return service.place(sku, quantity);
  }
}
