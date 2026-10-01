import { createMiddleware } from "hono/factory";


export const authMiddleware = createMiddleware(async (c,next)=>{
    try{
        const authorization = c.req.header("Authorization") || "";
        if(!authorization.startsWith("Bearer ")){
            return c.json({message: "Not a valid user"},401)
        }
        const token = authorization.slice(7).trim()
        if(!token){
            return c.json({message:"Token not found"},401);
        }
        if (token === process.env.TOKEN_SECRET){
            await next();
        }else{
            return c.json({message:"Invalid user"},401)
        }
        
    }catch(e){
       return c.json({message:"Internal server error"},500)
    }
})