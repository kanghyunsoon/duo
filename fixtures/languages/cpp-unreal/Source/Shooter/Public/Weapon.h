#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Weapon.generated.h"

UCLASS(Blueprintable)
class SHOOTER_API AWeapon : public AActor
{
    GENERATED_BODY()

public:
    UFUNCTION(BlueprintCallable, Category = "Combat")
    int32 Fire(int32 Requested);

    UPROPERTY(EditAnywhere)
    int32 Ammo = 30;
};
