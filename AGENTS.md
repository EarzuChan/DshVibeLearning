# 最高开发习惯

新写/修改代码时，需遵守以下原则：

1. **不得**在文档、注释、日志、报错文案等自然文本性内容中**写纯英文**。代码内的行注释需要写中文（允许专有名词/缩写写英文）、**使用中文标点**，且**不含行末句号**：即如`// TODO：xxx`。
2. 修改/新写代码时：
    1. **每一行**代码，非必要（即：不加分号会导致代码会被解析/编译错误，或无法正常工作），行末**绝不得带分号**：如`console.log("111)`
    2. 本来**能单行的代码**（如方法调用、变量赋值、类构造器）非必要（不折行导致代码会被解析/编译错误，或无法正常工作）**绝不得折行**（有些人为了“可读性”会折行这些代码，而主人对此严肃不认同）：
        - ```js
        // 建议：
        let senpai = new PersonBuilder(Nations.JAPAN).build().setAge(24).setRole(Roles.STUDENT)
        
        // 不得：（折行）
        let mamba = kobe.isAlive 
                        ?
                        mambaFactory.produce(Color.GOLDEN)
                        :
                        mambaFactory.produce(Color.BLACK)
        
        // 亦不得：（直接在等号后面折行）
        let mamba =
            kobe.mambaOutCanSay("WHAT_OUT_MAN", 8, 24, Spirit.MAMBA)
        ```
    3. 能**不要大括号包裹**就别包裹（如单语句的if/else/for等）：
        - ```js
        for (i = 0; i < 114514; i++) for (j = 0; j < 1919810; j++) if (i > j) console.log("iku iku") // 这也提现了尽可能不折行的特性
        
        // 不得出现这个，**这样的折行**（折行却没有大括号）很难看：
        /* for (i = 0; i < 114514; i++)
               if (mamba.isOut()) console.log("what mamba can say?")*/
        
        // 如果你为了美观和防止出错而想折行，亦或是for体里有多个语句里，则必须加花括号方折行，否则非必要（即：不折行/不加花括号导致代码会被解析/编译错误，或无法正常工作）不许折行也不许加花括号
        for (i = 0; i < 114514; i++) {
            // 这里折行是因为 if-else 会更好看
            if (i = 810) console.log("what can I say")
            else console.log("mamba out")
        }
        ```
    4. **复杂**的代码中，需要**根据逻辑区分情况**，适度**留出空行**，这赋予了代码**呼吸感**，方便**继续维护**：
        - ```js
        // 最舒服的情况：
        function membershipBasedRestaurantIntro() {
            const eaters = gashuin.bringTogether(tokugawa)
  
            scene.setEntities(junpei, eaters)
            junpei.speak(restaurantManifesto)
        
            const waiters = junpei.bringTogether(mahiro)
            const welcomeDrink = waiters.produce(HumanBody.PEE)
        
            while(welcomeDrink.isNotEmpty()) {
                try{
                    eaters.perform(person => person.drink(welcomeDrink))
                } catch (e) {
                    eaters.yell(e.message)
                }
            }
        
            switch (eaters.state) {
                case HumanState.NORMAL:
                    scene.proceedToNextScene(waiters, eaters)
                    break
        
                case HumanState.DANGER: 
                    console.log("由于食客身体抱恙，本次品鉴会到此结束")
            }
        }
        ```