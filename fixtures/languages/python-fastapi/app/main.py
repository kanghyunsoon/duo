from fastapi import FastAPI

from .users import create_user

app = FastAPI()


@app.post("/users")
def post_user(name: str) -> dict:
    return create_user(name)
