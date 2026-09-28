package com.example.orders;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class OrderServiceTest {
  @Test
  void placesAnOrder() {
    assertEquals(2, new OrderService().place("A-1", 2).quantity());
  }

  @Test
  void rejectsAnEmptyQuantity() {
    assertThrows(IllegalArgumentException.class, () -> new OrderService().place("A-1", 0));
  }
}
