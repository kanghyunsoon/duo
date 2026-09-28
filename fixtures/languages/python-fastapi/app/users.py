def normalize_name(name: str) -> str:
    return name.strip()


# duo: ACC-01
def create_user(name: str) -> dict:
    return {"name": normalize_name(name)}
