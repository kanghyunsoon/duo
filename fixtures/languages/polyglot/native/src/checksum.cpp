#include "checksum.hpp"

static unsigned mix(unsigned h, char c) { return h * 31u + static_cast<unsigned>(c); }

unsigned checksum(const char* data) {
  unsigned h = 0;
  while (*data != 0) h = mix(h, *data++);
  return h;
}
