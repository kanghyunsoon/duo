package com.example.api;

public class CartService {
  public long cartTotal(long[] items) {
    long sum = 0;
    for (long i : items) sum += i;
    return sum;
  }
}
