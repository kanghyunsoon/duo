def score(item):
    return item.get("views", 0)


def cart_total(items):
    return sum(score(i) for i in items)
